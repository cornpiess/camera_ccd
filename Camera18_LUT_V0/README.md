# Camera 18 — V0 LUT Pack

This pack contains **original starting LUTs** for Camera 18. They are not copied commercial LUTs and are not claimed to be 1:1 measurements of the named cameras.

Included:

- Canon G7 X II
- Ricoh Positive Film
- Ricoh Negative Film
- Leica M9
- Fujifilm Classic Chrome
- Fujifilm Classic Negative
- Hasselblad Natural
- CineStill 800T (color only; grain/halation must remain separate)

## Integration rule

Use the SAME `.cube` in preview and final output:

Preview:
`AVCaptureVideoDataOutput -> CIImage -> CIColorCube -> shared tone -> MTKView`

Final:
`AVCapturePhotoOutput -> CIImage -> SAME CIColorCube -> SAME tone -> final-only texture -> Photos`

This is the key to keeping preview and final output visually aligned.

## Important

These LUTs assume normalized, display-referred RGB input. They are creative/calibration starting points.

For real accuracy, later replace each V0 LUT by a measured LUT built from paired target-camera/iPhone captures.

## Recommended refinement order

1. G7 X II: Asian skin, indoor warm light, daylight skin
2. Ricoh Negative: greens, cyan shadows, street scenes
3. Leica M9: reds/oranges, foliage, mixed light
4. Fuji Classic Chrome: magenta suppression, cool shadows
5. Fuji Classic Negative: teal shadows vs warm highlights
6. Hasselblad Natural: skin neutrality and highlight smoothness
7. CineStill 800T: tungsten WB / neon; keep halation separate
