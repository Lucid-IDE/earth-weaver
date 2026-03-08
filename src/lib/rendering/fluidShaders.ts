// ── Screen-Space Fluid Rendering Shaders ─────────────────────────────
// Based on van der Laan et al. 2009 and narrow-band extensions

// ── 1. DEPTH PASS: Render particle depths ────────────────────────────

export const particleDepthVertexShader = `
varying vec3 vViewPosition;
varying float vRadius;

uniform float particleRadius;

void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
    
    // Point sprite size based on perspective
    float screenRadius = particleRadius * (1000.0 / length(mvPosition.xyz));
    gl_PointSize = screenRadius;
    vRadius = particleRadius;
}
`;

export const particleDepthFragmentShader = `
varying vec3 vViewPosition;
varying float vRadius;

uniform float near;
uniform float far;

void main() {
    // Discard pixels outside circular particle
    vec2 coord = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(coord, coord);
    if (r2 > 1.0) discard;
    
    // Reconstruct sphere depth (creates smooth particle surface)
    float z = sqrt(1.0 - r2);
    vec3 sphereNormal = normalize(vec3(coord, z));
    
    // Depth of this fragment on the sphere surface
    float depth = vViewPosition.z - z * vRadius;
    
    // Linearize depth for better filtering
    float linearDepth = (-depth - near) / (far - near);
    
    gl_FragColor = vec4(linearDepth, 0.0, 0.0, 1.0);
    
    // Write proper depth to depth buffer
    float ndc = (depth * projectionMatrix[2].z + projectionMatrix[3].z) / depth;
    gl_FragDepth = (ndc + 1.0) * 0.5;
}
`;

// ── 2. BILATERAL FILTER: Edge-preserving smoothing ───────────────────

export const bilateralFilterVertexShader = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const bilateralFilterFragmentShader = `
varying vec2 vUv;
uniform sampler2D depthTexture;
uniform vec2 resolution;
uniform float filterRadius;
uniform float blurScale;
uniform float blurDepthFalloff;

const int KERNEL_RADIUS = 8;

void main() {
    float centerDepth = texture2D(depthTexture, vUv).r;
    
    // Early out for background (no particle)
    if (centerDepth == 0.0) {
        gl_FragColor = vec4(0.0);
        return;
    }
    
    float sum = 0.0;
    float wsum = 0.0;
    
    // Bilateral filter: Gaussian in space × Gaussian in depth
    for (int x = -KERNEL_RADIUS; x <= KERNEL_RADIUS; x++) {
        for (int y = -KERNEL_RADIUS; y <= KERNEL_RADIUS; y++) {
            vec2 offset = vec2(float(x), float(y)) * blurScale / resolution;
            vec2 sampleUv = vUv + offset;
            
            // Clamp to valid texture coords
            if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;
            
            float sampleDepth = texture2D(depthTexture, sampleUv).r;
            if (sampleDepth == 0.0) continue; // background
            
            // Spatial weight (Gaussian based on distance)
            float r = length(vec2(float(x), float(y))) * filterRadius;
            float spatialWeight = exp(-r * r);
            
            // Range weight (Gaussian based on depth difference)
            float depthDiff = (sampleDepth - centerDepth) * blurDepthFalloff;
            float rangeWeight = exp(-depthDiff * depthDiff);
            
            float weight = spatialWeight * rangeWeight;
            sum += sampleDepth * weight;
            wsum += weight;
        }
    }
    
    float smoothedDepth = (wsum > 0.0) ? (sum / wsum) : centerDepth;
    gl_FragColor = vec4(smoothedDepth, 0.0, 0.0, 1.0);
}
`;

// ── 3. NORMAL RECONSTRUCTION: From smoothed depth ─────────────────────

export const normalReconstructionVertexShader = bilateralFilterVertexShader;

export const normalReconstructionFragmentShader = `
varying vec2 vUv;
uniform sampler2D smoothedDepthTexture;
uniform vec2 resolution;
uniform float near;
uniform float far;
uniform mat4 projectionMatrix;

vec3 getViewPosition(vec2 uv, float depth) {
    // Convert normalized depth back to view-space Z
    float viewZ = -mix(near, far, depth);
    
    // Reconstruct XY from UV
    vec2 ndc = uv * 2.0 - 1.0;
    float x = ndc.x * viewZ / projectionMatrix[0][0];
    float y = ndc.y * viewZ / projectionMatrix[1][1];
    
    return vec3(x, y, viewZ);
}

void main() {
    float depth = texture2D(smoothedDepthTexture, vUv).r;
    
    if (depth == 0.0) {
        gl_FragColor = vec4(0.5, 0.5, 1.0, 0.0); // Background (normal pointing at camera)
        return;
    }
    
    // Sample neighboring depths
    vec2 texelSize = 1.0 / resolution;
    float depthRight = texture2D(smoothedDepthTexture, vUv + vec2(texelSize.x, 0.0)).r;
    float depthLeft = texture2D(smoothedDepthTexture, vUv - vec2(texelSize.x, 0.0)).r;
    float depthUp = texture2D(smoothedDepthTexture, vUv + vec2(0.0, texelSize.y)).r;
    float depthDown = texture2D(smoothedDepthTexture, vUv - vec2(0.0, texelSize.y)).r;
    
    // Reconstruct view-space positions
    vec3 posCenter = getViewPosition(vUv, depth);
    vec3 posRight = getViewPosition(vUv + vec2(texelSize.x, 0.0), depthRight);
    vec3 posUp = getViewPosition(vUv + vec2(0.0, texelSize.y), depthUp);
    
    // Compute tangent vectors
    vec3 dx = posRight - posCenter;
    vec3 dy = posUp - posCenter;
    
    // Normal = cross product
    vec3 normal = normalize(cross(dx, dy));
    
    // Transform to [0,1] for storage
    gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
}
`;

// ── 4. FLUID SHADING: Phong lighting with reconstructed normals ──────

export const fluidShadingVertexShader = bilateralFilterVertexShader;

export const fluidShadingFragmentShader = `
varying vec2 vUv;
uniform sampler2D smoothedDepthTexture;
uniform sampler2D normalTexture;
uniform vec3 lightDirection;
uniform vec3 fluidColor;
uniform float roughness;
uniform float metalness;

void main() {
    float depth = texture2D(smoothedDepthTexture, vUv).r;
    
    // Background: transparent
    if (depth == 0.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }
    
    // Decode normal from [0,1] to [-1,1]
    vec3 normal = texture2D(normalTexture, vUv).rgb * 2.0 - 1.0;
    normal = normalize(normal);
    
    // Simple Lambertian diffuse
    float diffuse = max(0.0, dot(normal, lightDirection));
    
    // Ambient term
    float ambient = 0.3;
    
    // Specular (Blinn-Phong)
    vec3 viewDir = vec3(0.0, 0.0, 1.0); // Assuming camera looks down -Z
    vec3 halfDir = normalize(lightDirection + viewDir);
    float specPower = mix(5.0, 50.0, 1.0 - roughness);
    float spec = pow(max(0.0, dot(normal, halfDir)), specPower) * (1.0 - roughness);
    
    // Combine lighting
    vec3 litColor = fluidColor * (ambient + diffuse * 0.7) + vec3(spec * 0.3);
    
    // Depth-based darkening (particles deeper in piles are slightly darker)
    float depthDarken = 1.0 - depth * 0.2;
    litColor *= depthDarken;
    
    gl_FragColor = vec4(litColor, 1.0);
}
`;
