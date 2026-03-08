// ── Dirt Splat Shaders ───────────────────────────────────────────────
// Smaller, denser splats that match the SDF terrain's stratigraphy,
// moisture darkening, and organic surface tones for seamless visual continuity.

export const dirtSplatVertexShader = /* glsl */ `
  attribute vec3 instancePosition;
  attribute vec4 instanceColor;
  attribute float instanceScale;
  attribute float instanceRotation;
  attribute float instanceNoisePhase;
  attribute float instanceMoisture;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vNoisePhase;
  varying float vDepth;
  varying vec3 vWorldPos;
  varying float vMoisture;

  void main() {
    vUv = uv;
    vColor = instanceColor.rgb;
    vNoisePhase = instanceNoisePhase;
    vMoisture = instanceMoisture;

    // Billboard: construct camera-facing quad
    vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 cameraUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    // Apply per-instance rotation around view axis
    float c = cos(instanceRotation);
    float s = sin(instanceRotation);
    vec3 rotRight = cameraRight * c + cameraUp * s;
    vec3 rotUp = -cameraRight * s + cameraUp * c;

    float size = instanceScale;
    vec3 vertexPos = instancePosition
      + rotRight * position.x * size
      + rotUp * position.y * size;

    vWorldPos = vertexPos;
    
    vec4 mvPos = modelViewMatrix * vec4(vertexPos, 1.0);
    vDepth = -mvPos.z;
    
    gl_Position = projectionMatrix * mvPos;
  }
`;

export const dirtSplatFragmentShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vNoisePhase;
  varying float vDepth;
  varying vec3 vWorldPos;
  varying float vMoisture;

  // Simple hash noise
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // FBM noise for irregular edges and surface detail
  float fbm(vec2 p) {
    float v = 0.0;
    v += 0.5 * noise2D(p * 1.0);
    v += 0.25 * noise2D(p * 2.0);
    v += 0.125 * noise2D(p * 4.0);
    v += 0.0625 * noise2D(p * 8.0);
    return v;
  }

  void main() {
    vec2 centered = vUv * 2.0 - 1.0;
    float dist = length(centered);
    
    // Soft circular falloff with noisy edges — tighter for smaller splats
    float noiseVal = fbm(centered * 4.0 + vNoisePhase * 10.0);
    float edgeNoise = noiseVal * 0.25;
    
    // Tighter core, softer edge for denser overlap blending
    float alpha = 1.0 - smoothstep(0.2, 0.75 + edgeNoise, dist);
    
    if (alpha < 0.01) discard;
    
    // Surface detail: grain texture matching SDF soil shader
    float grain = fbm(centered * 12.0 + vNoisePhase * 5.0);
    float microGrain = noise2D(centered * 30.0 + vNoisePhase * 3.0) * 0.04;
    
    // Cracks in dry soil
    float cracks = smoothstep(0.46, 0.54, noise2D(centered * 16.0 + vNoisePhase * 2.0));
    
    // Lighting — hemisphere approximation matching SDF terrain shader
    float nx = (noise2D((centered + vec2(0.01, 0.0)) * 8.0 + vNoisePhase) 
              - noise2D((centered - vec2(0.01, 0.0)) * 8.0 + vNoisePhase)) * 2.0;
    float ny = (noise2D((centered + vec2(0.0, 0.01)) * 8.0 + vNoisePhase) 
              - noise2D((centered - vec2(0.0, 0.01)) * 8.0 + vNoisePhase)) * 2.0;
    vec3 fakeNormal = normalize(vec3(nx, ny, 1.0));
    
    // Match SDF shader's dual-light setup
    vec3 L1 = normalize(vec3(0.5, 0.8, 0.3));
    vec3 L2 = normalize(vec3(-0.3, 0.5, -0.6));
    float NdotL1 = max(dot(fakeNormal, L1), 0.0);
    float NdotL2 = max(dot(fakeNormal, L2), 0.0);
    
    // Warm key + cool fill (same as SDF shader)
    vec3 keyLight = vec3(1.0, 0.95, 0.85) * NdotL1 * 0.65;
    vec3 fillLight = vec3(0.6, 0.7, 0.85) * NdotL2 * 0.2;
    float ambient = 0.25;
    
    // SSS approximation
    float sss = max(0.0, dot(-fakeNormal, L1)) * 0.06;
    vec3 sssColor = vec3(0.6, 0.4, 0.2) * sss * (1.0 + vMoisture);
    
    // Moisture effects: wet soil is shinier
    float specPower = mix(16.0, 80.0, vMoisture);
    vec3 viewDir = normalize(vec3(0.0, 0.0, 1.0));
    vec3 H = normalize(L1 + viewDir);
    float spec = pow(max(dot(fakeNormal, H), 0.0), specPower) * mix(0.02, 0.12, vMoisture);
    
    // Wet tint (matching SDF shader)
    vec3 wetTint = vec3(0.35, 0.25, 0.15);
    vec3 color = mix(vColor, wetTint, vMoisture * 0.15);
    
    // Apply lighting
    color *= (ambient + keyLight + fillLight);
    color += vec3(spec) + sssColor;
    
    // Surface detail
    color *= 0.88 + grain * 0.24;
    color += microGrain;
    color *= 0.92 + cracks * 0.08;
    
    // Center-based AO
    float ao = mix(0.75, 1.0, smoothstep(0.0, 0.4, dist));
    color *= ao;
    
    // Edge darkening (subsurface fake)
    color *= mix(0.88, 1.0, 1.0 - dist * 0.25);
    
    // Depth fog matching SDF shader
    float fogFactor = 1.0 - exp(-vDepth * 0.4);
    vec3 fogColor = vec3(0.03, 0.05, 0.07);
    color = mix(color, fogColor, fogFactor * 0.3);
    
    // Gamma correction (matching SDF shader)
    color = pow(color, vec3(1.0 / 2.2));
    
    gl_FragColor = vec4(color, alpha * 0.95);
  }
`;

// ── Dust Particle Shaders ────────────────────────────────────────────
export const dustVertexShader = /* glsl */ `
  attribute vec3 instancePosition;
  attribute float instanceAlpha;
  attribute float instanceScale;

  varying vec2 vUv;
  varying float vAlpha;

  void main() {
    vUv = uv;
    vAlpha = instanceAlpha;

    vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 cameraUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    float size = instanceScale;
    vec3 vertexPos = instancePosition
      + cameraRight * position.x * size
      + cameraUp * position.y * size;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(vertexPos, 1.0);
  }
`;

export const dustFragmentShader = /* glsl */ `
  varying vec2 vUv;
  varying float vAlpha;

  void main() {
    vec2 centered = vUv * 2.0 - 1.0;
    float dist = length(centered);
    float alpha = (1.0 - smoothstep(0.0, 1.0, dist)) * vAlpha;
    if (alpha < 0.01) discard;
    
    // Warm dust color matching soil palette
    vec3 dustColor = vec3(0.60, 0.50, 0.35);
    gl_FragColor = vec4(dustColor, alpha * 0.35);
  }
`;
