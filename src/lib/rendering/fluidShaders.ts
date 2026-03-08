// ── Screen-Space Fluid Rendering Shaders ─────────────────────────────
// Multi-pass pipeline: Depth → Bilateral Filter → Normal Recon → Shading
// Based on van der Laan et al. 2009 screen-space fluid rendering

// ── 1. DEPTH PASS: Render particle depths as spherical impostors ─────

export const particleDepthVertexShader = /* glsl */ `
attribute vec3 instancePosition;
attribute float instanceRadius;
attribute vec4 instanceColor;

varying vec3 vViewPosition;
varying float vRadius;
varying vec3 vColor;

void main() {
    vec4 mvPosition = modelViewMatrix * vec4(instancePosition, 1.0);
    vViewPosition = mvPosition.xyz;
    vColor = instanceColor.rgb;
    
    // Point sprite size based on perspective
    float screenRadius = instanceRadius * (800.0 / length(mvPosition.xyz));
    gl_PointSize = max(screenRadius, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    vRadius = instanceRadius;
}
`;

export const particleDepthFragmentShader = /* glsl */ `
varying vec3 vViewPosition;
varying float vRadius;
varying vec3 vColor;

uniform float near;
uniform float far;

void main() {
    // Discard pixels outside circular particle
    vec2 coord = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(coord, coord);
    if (r2 > 1.0) discard;
    
    // Reconstruct sphere depth
    float z = sqrt(1.0 - r2);
    
    // Depth of this fragment on the sphere surface
    float depth = vViewPosition.z + z * vRadius;
    
    // Linearize depth for filtering
    float linearDepth = (-depth - near) / (far - near);
    
    // Pack color into gba channels for later retrieval
    gl_FragColor = vec4(linearDepth, vColor.r, vColor.g, vColor.b);
    
    // Write proper depth to depth buffer
    vec4 clipPos = projectionMatrix * vec4(vViewPosition.xy, depth, 1.0);
    float ndc = clipPos.z / clipPos.w;
    gl_FragDepth = (ndc + 1.0) * 0.5;
}
`;

// ── 2. BILATERAL FILTER: Edge-preserving depth smoothing ─────────────

export const fullscreenQuadVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const bilateralFilterFragmentShader = /* glsl */ `
varying vec2 vUv;
uniform sampler2D depthTexture;
uniform vec2 resolution;
uniform vec2 filterDirection; // (1,0) for horizontal, (0,1) for vertical
uniform float blurScale;
uniform float blurDepthFalloff;

const int KERNEL_RADIUS = 10;

void main() {
    vec4 centerSample = texture2D(depthTexture, vUv);
    float centerDepth = centerSample.r;
    
    // Background: no particle
    if (centerDepth <= 0.001) {
        gl_FragColor = vec4(0.0);
        return;
    }
    
    float sum = 0.0;
    vec3 colorSum = vec3(0.0);
    float wsum = 0.0;
    
    for (int i = -KERNEL_RADIUS; i <= KERNEL_RADIUS; i++) {
        vec2 offset = filterDirection * float(i) * blurScale / resolution;
        vec2 sampleUv = vUv + offset;
        
        if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;
        
        vec4 sampleVal = texture2D(depthTexture, sampleUv);
        float sampleDepth = sampleVal.r;
        if (sampleDepth <= 0.001) continue;
        
        // Spatial weight (Gaussian)
        float r = float(i);
        float spatialWeight = exp(-r * r / 50.0);
        
        // Range weight (depth similarity)
        float depthDiff = (sampleDepth - centerDepth) * blurDepthFalloff;
        float rangeWeight = exp(-depthDiff * depthDiff);
        
        float weight = spatialWeight * rangeWeight;
        sum += sampleDepth * weight;
        colorSum += sampleVal.gba * weight;
        wsum += weight;
    }
    
    if (wsum > 0.0) {
        gl_FragColor = vec4(sum / wsum, colorSum / wsum);
    } else {
        gl_FragColor = centerSample;
    }
}
`;

// ── 3. NORMAL RECONSTRUCTION + SHADING ───────────────────────────────
// Combined pass: reconstruct normals from smoothed depth, then shade
// using the same material model as the SDF terrain shader.

export const fluidCompositingFragmentShader = /* glsl */ `
varying vec2 vUv;
uniform sampler2D smoothedDepthTexture;
uniform vec2 resolution;
uniform float near;
uniform float far;
uniform mat4 invProjectionMatrix;

// Reconstruct view-space position from UV + linear depth
vec3 getViewPosition(vec2 uv, float linearDepth) {
    float viewZ = -(near + linearDepth * (far - near));
    vec2 ndc = uv * 2.0 - 1.0;
    // Use inverse projection to get proper XY
    vec4 clipPos = vec4(ndc, 0.0, 1.0);
    vec4 viewPos = invProjectionMatrix * clipPos;
    vec2 viewXY = viewPos.xy / viewPos.w;
    return vec3(viewXY * (-viewZ), viewZ);
}

// ── Simplex noise (for stratigraphy matching) ──
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
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

void main() {
    vec4 centerSample = texture2D(smoothedDepthTexture, vUv);
    float depth = centerSample.r;
    
    // Background: fully transparent
    if (depth <= 0.001) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }
    
    // ── Reconstruct normals from depth gradients ──
    vec2 texelSize = 1.0 / resolution;
    
    float depthR = texture2D(smoothedDepthTexture, vUv + vec2(texelSize.x, 0.0)).r;
    float depthL = texture2D(smoothedDepthTexture, vUv - vec2(texelSize.x, 0.0)).r;
    float depthU = texture2D(smoothedDepthTexture, vUv + vec2(0.0, texelSize.y)).r;
    float depthD = texture2D(smoothedDepthTexture, vUv - vec2(0.0, texelSize.y)).r;
    
    // Use central differences where possible, forward/backward at edges
    float dzdx = (depthR > 0.001 && depthL > 0.001) 
        ? (depthR - depthL) * 0.5 
        : (depthR > 0.001 ? depthR - depth : depth - depthL);
    float dzdy = (depthU > 0.001 && depthD > 0.001) 
        ? (depthU - depthD) * 0.5 
        : (depthU > 0.001 ? depthU - depth : depth - depthD);
    
    vec3 N = normalize(vec3(-dzdx * resolution.x * 0.5, -dzdy * resolution.y * 0.5, 1.0));
    
    // ── Retrieve particle color from filtered texture ──
    vec3 baseColor = centerSample.gba;
    
    // ── Add grain noise based on screen position (approximating world pos) ──
    vec3 approxWorldPos = getViewPosition(vUv, depth);
    float grain = snoise(approxWorldPos * 50.0) * 0.02;
    baseColor += grain;
    
    // ── Lighting — matching SDF terrain shader exactly ──
    vec3 V = vec3(0.0, 0.0, 1.0); // view direction in view space
    
    vec3 L1 = normalize(vec3(0.5, 0.8, 0.3));
    vec3 L2 = normalize(vec3(-0.3, 0.5, -0.6));
    float NdotL1 = max(dot(N, L1), 0.0);
    float NdotL2 = max(dot(N, L2), 0.0);
    
    // Warm key + cool fill
    vec3 keyLight = vec3(1.0, 0.95, 0.85) * NdotL1 * 0.7;
    vec3 fillLight = vec3(0.6, 0.7, 0.85) * NdotL2 * 0.25;
    float ambient = 0.22;
    
    // SSS approximation
    float sss = max(0.0, dot(-N, L1)) * 0.08;
    vec3 sssColor = vec3(0.6, 0.4, 0.2) * sss;
    
    // Specular (Blinn-Phong)
    vec3 H1 = normalize(L1 + V);
    float spec1 = pow(max(dot(N, H1), 0.0), 32.0) * 0.08;
    
    vec3 color = baseColor * (ambient + keyLight + fillLight) + vec3(spec1) + sssColor;
    
    // Rim light for edge definition
    float rim = 1.0 - max(dot(N, V), 0.0);
    color += vec3(0.08, 0.06, 0.04) * pow(rim, 3.0);
    
    // AO from normal direction
    float ao = 0.7 + 0.3 * max(N.y, 0.0);
    color *= ao;
    
    // Depth fog
    float fogFactor = 1.0 - exp(-depth * 2.0);
    vec3 fogColor = vec3(0.03, 0.05, 0.07);
    color = mix(color, fogColor, fogFactor * 0.3);
    
    // Gamma correction
    color = pow(color, vec3(1.0 / 2.2));
    
    gl_FragColor = vec4(color, 1.0);
}
`;
