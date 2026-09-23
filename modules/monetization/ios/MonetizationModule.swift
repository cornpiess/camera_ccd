import ExpoModulesCore
import StoreKit
import Security
import UIKit

/**
 * Monetization native side — two independent halves, both deliberately kept OUT of
 * the capture hot path (all of this is called before the shutter only, or from UI):
 *
 * 1. SubscriptionManager (StoreKit 2): products, purchase, restore, entitlements.
 *    StoreKit transactions are the single source of truth for `isPro` — nothing is
 *    cached in UserDefaults. Billing Grace Period entitlements stay valid because
 *    `Transaction.currentEntitlements` includes them.
 *
 * 2. CameraTrialStore (Keychain): per-premium-profile used shot counts plus an
 *    in-memory in-flight reservation set, so a remaining-1 quota cannot be raced
 *    into multiple saved photos by rapid shutter taps. Reinstall-survivable via the
 *    Keychain (thisDeviceOnly); it is an honesty measure, not an anti-cheat system.
 *
 * The module NEVER touches the camera pipeline; it only answers "may this profile
 * take a real capture right now" style questions for the JS CameraAccessPolicy.
 */

// MARK: - Product catalog

/// Product identifiers (App Store Connect subscription group "Camera 18 Pro").
/// Prices are ALWAYS read from StoreKit (`Product.displayPrice`) — never hardcoded;
/// the USD figures only exist in App Store Connect / the .storekit test file.
private let monthlyProductID = "camera18.pro.monthly"
private let yearlyProductID = "camera18.pro.yearly"
private let trialLimit = 3

// MARK: - CameraTrialStore (Keychain)

/// Serial, in-memory-cached view over the Keychain-persisted trial document.
private final class CameraTrialStore {
  private struct Document: Codable {
    var version: Int = 1
    var usedShots: [String: Int] = [:]
  }

  private let service: String
  private let account = "trialStore"
  private let queue = DispatchQueue(label: "camera18.monetization.trial")
  private var document: Document
  /// Reservation bookkeeping (memory-only by design: a killed process simply loses
  /// them; `usedShots` is the only permanent record).
  private var inFlight: [String: Int] = [:]

  init(service: String) {
    self.service = service
    self.document = Self.load(service: service, account: account) ?? Document()
  }

  private static func load(service: String, account: String) -> Document? {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data else { return nil }
    return try? JSONDecoder().decode(Document.self, from: data)
  }

  private func persist() {
    guard let data = try? JSONEncoder().encode(document) else { return }
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var query = base
    query[kSecReturnData as String] = true
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecSuccess {
      SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
    } else {
      SecItemAdd(base.merging(attributes) { _, new in new } as CFDictionary, nil)
    }
  }

  private func clamped(_ value: Int) -> Int {
    return min(max(value, 0), trialLimit)
  }

  /// Synchronous snapshot of the permanent record (used counts only).
  func usedShotsSnapshot() -> [String: Int] {
    return queue.sync { document.usedShots }
  }

  /// Atomically claims one trial shot: succeeds only while
  /// `trialLimit - used - inFlight > 0`. The count is only permanent after `commit`.
  func reserve(profileID: String) -> Bool {
    return queue.sync {
      let used = clamped(document.usedShots[profileID] ?? 0)
      let reserved = inFlight[profileID] ?? 0
      guard trialLimit - used - reserved > 0 else { return false }
      inFlight[profileID] = reserved + 1
      return true
    }
  }

  /// A successfully SAVED photo consumed one trial shot (spec: only a saved photo
  /// consumes; capture/processing/save failures roll back instead).
  func commit(profileID: String) {
    queue.sync {
      let used = clamped(document.usedShots[profileID] ?? 0)
      document.usedShots[profileID] = clamped(used + 1)
      if let reserved = inFlight[profileID] {
        inFlight[profileID] = max(0, reserved - 1)
      }
      persist()
    }
  }

  /// The capture pipeline failed — give the reserved shot back.
  func rollback(profileID: String) {
    queue.sync {
      if let reserved = inFlight[profileID] {
        inFlight[profileID] = max(0, reserved - 1)
      }
    }
  }

  /// TESTING BUILDS ONLY: wipe the trial record (developer convenience).
  func reset() {
    queue.sync {
      document = Document()
      inFlight = [:]
      persist()
    }
  }
}

// MARK: - Expo module

public final class MonetizationModule: Module {
  private let trialStore = CameraTrialStore(service: "com.cornpiess.camera18.trials")
  private var updatesTask: Task<Void, Never>?
  // Cold-start entitlement cache (user requirement 2026-09-24: the app opens with ZERO
  // StoreKit/network activity — the OS network-permission prompt must only appear when
  // the user touches a monetization surface). A plain bool, not a secret: UserDefaults
  // is fine. Refreshed by every authoritative pass (paywall open / purchase / restore /
  // renewal events) once the StoreKit session is open.
  private let proCacheKey = "monetization.isPro.cached"

  private var cachedIsPro: Bool {
    get { UserDefaults.standard.bool(forKey: proCacheKey) }
    set { UserDefaults.standard.set(newValue, forKey: proCacheKey) }
  }

  /// Starts the Transaction.updates listener exactly once (idempotent). Called
  /// lazily — never at module creation — so a launch without any monetization
  /// interaction never opens a StoreKit session (and never asks for network).
  private func startUpdatesListener() {
    guard updatesTask == nil else { return }
    updatesTask = Task.detached { [weak self] in
      for await update in Transaction.updates {
        await self?.handle(transactionResult: update)
      }
    }
    // The session is open (network is in play from here on) — calibrate the local
    // cache once so a returning subscriber is recognized without any further taps.
    Task { [weak self] in
      let pro = await Self.computeIsPro()
      self?.cachedIsPro = pro
      self?.sendEvent("onProChanged", ["isPro": pro])
    }
  }

  public func definition() -> ModuleDefinition {
    Name("Monetization")

    Events("onProChanged")

    OnCreate {
      // DELIBERATELY NOT starting the StoreKit Transaction.updates listener here:
      // opening the StoreKit session at launch is what triggered the OS
      // network-permission prompt on first run (user-reported on build 90). An
      // offline-first camera must not touch the network for merely existing. The
      // listener starts lazily on the first monetization surface (paywall open /
      // purchase / restore) via startUpdatesListener().
    }

    OnDestroy {
      updatesTask?.cancel()
    }

    /// Idempotent lazy start of the lifetime StoreKit listener (new purchases,
    /// renewals, status changes, refunds). Exposed as startStoreKit() and called
    /// by the JS side when the user first touches a monetization surface.
    AsyncFunction("startStoreKit") { (promise: Promise) in
      Task {
        self.startUpdatesListener()
        promise.resolve(nil)
      }
    }

    // -- Entitlements -------------------------------------------------------

    /// `isPro` = a verified, currently-valid (incl. Grace Period) entitlement for
    /// either product. COLD-START ZERO-NETWORK CONTRACT: while the StoreKit session
    /// is closed (no monetization surface touched yet) this answers from the LOCAL
    /// cache only — Transaction.currentEntitlements itself initializes the StoreKit
    /// session and pops the OS network-permission dialog (the onboarding-time prompt
    /// the user reported). Once the session is open, every call is the authoritative
    /// pass and refreshes the cache.
    AsyncFunction("isPro") { (promise: Promise) in
      guard self.updatesTask != nil else {
        promise.resolve(self.cachedIsPro)
        return
      }
      Task {
        let pro = await Self.computeIsPro()
        self.cachedIsPro = pro
        self.sendEvent("onProChanged", ["isPro": pro])
        promise.resolve(pro)
      }
    }

    // -- Products ------------------------------------------------------------

    /// Localized products for the paywall. Price strings come from StoreKit only.
    AsyncFunction("getProducts") { (promise: Promise) in
      Task {
        do {
          let products = try await Product.products(for: [monthlyProductID, yearlyProductID])
          let payload: [[String: Any]] = products.map { product in
            [
              "id": product.id,
              "displayPrice": product.displayPrice,
              "period": product.id == yearlyProductID ? "yearly" : "monthly",
            ]
          }
          promise.resolve(payload)
        } catch {
          // Store offline / products not configured: the camera stays fully usable.
          promise.resolve([[String: Any]]())
        }
      }
    }

    // -- Purchase ------------------------------------------------------------

    /// One purchase attempt. Resolves a result OBJECT (never rejects on the
    /// expected user-visible paths) so the JS side can branch without exceptions:
    /// {ok:true} | {ok:false, reason:"unverified"|"failed"} | {pending:true} | {cancelled:true}
    AsyncFunction("purchase") { (productID: String, promise: Promise) in
      Task {
        // The user is buying — StoreKit is on the network now anyway; make sure the
        // lifetime updates listener runs from here on (renewals/refunds mid-run).
        self.startUpdatesListener()
        do {
          let products = try await Product.products(for: [productID])
          guard let product = products.first else {
            promise.resolve(["ok": false, "reason": "failed"])
            return
          }
          let result = try await product.purchase()
          switch result {
          case .success(let verification):
            switch verification {
            case .verified(let transaction):
              await transaction.finish()
              let pro = await Self.computeIsPro()
              self.cachedIsPro = pro
              self.sendEvent("onProChanged", ["isPro": pro])
              promise.resolve(["ok": true, "isPro": pro])
            case .unverified:
              // Never grant Pro on an unverified transaction.
              promise.resolve(["ok": false, "reason": "unverified"])
            }
          case .pending:
            promise.resolve(["pending": true])
          case .userCancelled:
            promise.resolve(["cancelled": true])
          @unknown default:
            promise.resolve(["ok": false, "reason": "failed"])
          }
        } catch {
          promise.resolve(["ok": false, "reason": "failed"])
        }
      }
    }

    /// ONLY from an explicit user tap (never on launch): AppStore.sync() then a
    /// fresh entitlement pass. {restored:true} when an active subscription exists.
    AsyncFunction("restorePurchases") { (promise: Promise) in
      Task {
        self.startUpdatesListener()
        do {
          try await AppStore.sync()
        } catch {
          // Sync can fail offline; currentEntitlements is still the honest answer.
        }
        let pro = await Self.computeIsPro()
        self.cachedIsPro = pro
        self.sendEvent("onProChanged", ["isPro": pro])
        promise.resolve(["restored": pro])
      }
    }

    /// Official StoreKit manage-subscription sheet (iOS 15+). Rejects softly when
    /// unavailable; the JS side falls back to the App Store account URL.
    AsyncFunction("showManageSubscriptions") { (promise: Promise) in
      if #available(iOS 15.0, *) {
        Task { @MainActor in
          // Single-window iPhone app: the first connected UIWindowScene is THE scene.
          // (activationStatus deliberately not used — it failed to resolve on the
          // CI runner SDK and dragged the whole closure's type inference down.)
          let anyScene = UIApplication.shared.connectedScenes.first { $0 is UIWindowScene }
          guard let windowScene = anyScene as? UIWindowScene else {
            promise.reject("ERR_MANAGE_UNAVAILABLE", "No active window scene")
            return
          }
          do {
            try await AppStore.showManageSubscriptions(in: windowScene)
            promise.resolve(nil)
          } catch {
            promise.reject("ERR_MANAGE_FAILED", error.localizedDescription)
          }
        }
      } else {
        promise.reject("ERR_MANAGE_UNAVAILABLE", "iOS 15 required")
      }
    }

    // -- Trial store ----------------------------------------------------------

    Function("getTrialUsedShots") { () -> [String: Int] in
      trialStore.usedShotsSnapshot()
    }

    Function("reserveTrialShot") { (profileID: String) -> Bool in
      trialStore.reserve(profileID: profileID)
    }

    Function("commitTrialShot") { (profileID: String) in
      trialStore.commit(profileID: profileID)
    }

    Function("rollbackTrialShot") { (profileID: String) in
      trialStore.rollback(profileID: profileID)
    }

    // TESTING BUILDS ONLY (mirrors the camera-engine CAMERA18_TESTING gate): wipe
    // the trial record so 3-shot flows can be re-tested without a reinstall.
    Function("resetTrials") { () -> Bool in
      #if DEBUG || CAMERA18_TESTING
      trialStore.reset()
      return true
      #else
      return false
      #endif
    }
  }

  private func handle(transactionResult: VerificationResult<Transaction>) async {
    guard case .verified(let transaction) = transactionResult else {
      // Unverified signature (spoofed receipt etc.): finish WITHOUT granting any
      // entitlement — otherwise StoreKit 2 re-delivers the same transaction on
      // every launch and handle() spins on it forever.
      if case .unverified(let unverified, _) = transactionResult {
        await unverified.finish()
      }
      return
    }
    await transaction.finish()
    let pro = await Self.computeIsPro()
    cachedIsPro = pro
    sendEvent("onProChanged", ["isPro": pro])
  }

  private static func computeIsPro() async -> Bool {
    for await entitlement in Transaction.currentEntitlements {
      guard case .verified(let transaction) = entitlement else { continue }
      guard transaction.revocationDate == nil else { continue }
      if transaction.productID == monthlyProductID || transaction.productID == yearlyProductID {
        return true
      }
    }
    return false
  }
}
