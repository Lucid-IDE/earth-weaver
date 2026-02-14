export const soilVertexShader = /* glsl */ `
attribute float aDisturbanceAge;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vDisturbanceAge;
varying vec3 vViewDir;

void main() {
  vec4 worldPos4 = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos4.xyz;
  vNormal = normalize(normalMatrix * normal);
  vDisturbanceAge = aDisturbanceAge;
  vViewDir = normalize(cameraPosition - vWorldPos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const soilFragmentShader = /* glsl */ `
// --- Simplex noise (Ashima Arts / Stefan Gustavson) ---
vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289v4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289v4(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289v3(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x2_ = x_ * ns.x + ns.yyyy;
  vec4 y2_ = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x2_) - abs(y2_);

  vec4 b0 = vec4(x2_.xy, y2_.xy);
  vec4 b1 = vec4(x2_.zw, y2_.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm(vec3 p, int octaves) {
  float value = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxAmp = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    value += snoise(p * freq) * amp;
    maxAmp += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return value / maxAmp;
}

// --- M(x): Material Brain ---
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vDisturbanceAge;
varying vec3 vViewDir;

uniform vec3 uLightDir;
uniform vec3 uLightDir2;
uniform float uTime;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vViewDir);

  // --- Stratigraphy ---
  vec3 beddingNormal = normalize(vec3(0.05, 1.0, 0.03));
  float warp = snoise(vWorldPos * 2.5) * 0.04 + snoise(vWorldPos * 7.0) * 0.012;
  float s = dot(vWorldPos, beddingNormal) + warp;

  float layerThickness = 0.055;
  float layerCoord = s / layerThickness;
  float layerFrac = fract(layerCoord);
  int layerId = int(mod(floor(layerCoord) + 20.0, 7.0));

  // Layer colors — each recognizable soil type
  vec3 baseColor;
  if (layerId == 0) baseColor = vec3(0.76, 0.70, 0.50);       // dry sand
  else if (layerId == 1) baseColor = vec3(0.52, 0.36, 0.24);   // clay
  else if (layerId == 2) baseColor = vec3(0.65, 0.55, 0.40);   // silt
  else if (layerId == 3) baseColor = vec3(0.28, 0.22, 0.14);   // organic/peat
  else if (layerId == 4) baseColor = vec3(0.58, 0.56, 0.52);   // gravel
  else if (layerId == 5) baseColor = vec3(0.48, 0.40, 0.30);   // loam
  else baseColor = vec3(0.68, 0.58, 0.40);                     // sandy silt

  // Soft inter-layer blending
  float edgeBlend = smoothstep(0.0, 0.12, layerFrac) * (1.0 - smoothstep(0.88, 1.0, layerFrac));
  int nextLayer = int(mod(floor(layerCoord) + 21.0, 7.0));
  vec3 nextColor;
  if (nextLayer == 0) nextColor = vec3(0.76, 0.70, 0.50);
  else if (nextLayer == 1) nextColor = vec3(0.52, 0.36, 0.24);
  else if (nextLayer == 2) nextColor = vec3(0.65, 0.55, 0.40);
  else if (nextLayer == 3) nextColor = vec3(0.28, 0.22, 0.14);
  else if (nextLayer == 4) nextColor = vec3(0.58, 0.56, 0.52);
  else if (nextLayer == 5) nextColor = vec3(0.48, 0.40, 0.30);
  else nextColor = vec3(0.68, 0.58, 0.40);
  baseColor = mix(nextColor, baseColor, edgeBlend);

  // Organic boost near surface (worldPos.y near 0)
  float surfaceProximity = 1.0 - smoothstep(-0.02, 0.12, -vWorldPos.y);
  baseColor = mix(baseColor, vec3(0.22, 0.18, 0.10), surfaceProximity * 0.55);

  // Gravel lens (3D blob noise override)
  float lens = snoise(vWorldPos * 6.0);
  if (lens > 0.55) {
    float lensStrength = smoothstep(0.55, 0.8, lens);
    baseColor = mix(baseColor, vec3(0.55, 0.52, 0.48), lensStrength * 0.7);
  }

  // Micro grain noise
  float grain = snoise(vWorldPos * 50.0) * 0.025;
  baseColor += grain;

  // --- Cut Face Realism ---
  float freshness = 1.0 - vDisturbanceAge;
  // Fresh cuts are slightly darker and smoother
  baseColor *= mix(1.0, 0.80, freshness);
  float roughness = mix(0.92, 0.55, freshness);

  // Subtle wet sheen on fresh cuts
  float specPower = mix(16.0, 64.0, freshness);
  float specStrength = mix(0.02, 0.15, freshness);

  // --- Lighting ---
  vec3 L1 = normalize(uLightDir);
  vec3 L2 = normalize(uLightDir2);
  float NdotL1 = max(dot(N, L1), 0.0);
  float NdotL2 = max(dot(N, L2), 0.0);

  // Warm key + cool fill
  vec3 keyLight = vec3(1.0, 0.95, 0.85) * NdotL1 * 0.7;
  vec3 fillLight = vec3(0.6, 0.7, 0.85) * NdotL2 * 0.25;
  float ambient = 0.22;

  // Specular (Blinn-Phong)
  vec3 H1 = normalize(L1 + V);
  float spec1 = pow(max(dot(N, H1), 0.0), specPower) * specStrength;

  vec3 color = baseColor * (ambient + keyLight + fillLight) + vec3(spec1);

  // Rim light for depth
  float rim = 1.0 - max(dot(N, V), 0.0);
  color += vec3(0.08, 0.06, 0.04) * pow(rim, 3.0);

  // Subtle AO from normal direction (darker underneath)
  float ao = 0.7 + 0.3 * max(dot(N, vec3(0.0, 1.0, 0.0)), 0.0);
  color *= ao;

  // Gamma correction
  color = pow(color, vec3(1.0 / 2.2));

  gl_FragColor = vec4(color, 1.0);
}
`;
