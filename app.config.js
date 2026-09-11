// 动态 Expo 配置：唯一目的是让 CI 注入递增的 iOS build number。
//
// 为什么需要这一层：App Store Connect 要求每次上传的 CFBundleVersion 严格大于上一次，
// 否则上传会被拒（"The bundle version must be higher than the previously uploaded version"）。
// app.json 是静态文件，读不到 CI 的 run number，所以用 app.config.js 包一层。
//
// 不设置 IOS_BUILD_NUMBER 时（本地 expo start / prebuild / EAS），行为与只有 app.json 时完全一致。
//
// 写入方：.github/workflows/ios-testflight.yml 的 prebuild 步骤（IOS_BUILD_NUMBER=${{ github.run_number }}）

module.exports = ({ config }) => ({
  ...config,
  ios: {
    ...config.ios,
    buildNumber: process.env.IOS_BUILD_NUMBER || config.ios?.buildNumber || '1',
  },
});
