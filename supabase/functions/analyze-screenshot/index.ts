import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM_PROMPT = `You are an expert simulation physicist and graphics engineer specializing in:
- MLS-MPM (Moving Least Squares Material Point Method)
- Drucker-Prager elastoplasticity with Neo-Hookean Kirchhoff stress
- WebGPU compute shaders, WGSL, and rendering pipelines
- Real-time physics simulation optimization
- Substrate-Aligned Computing (SAC) methodology

You are analyzing a screenshot from Project MAELSTROM — a WebGPU MLS-MPM soil/fluid simulation.

CONTEXT FROM PRINCIPIA MORPHICA (project design document):
- The project uses SAC: aligning numerical methods with GPU substrate topology
- Three experiment lanes: Authoritative (strict), Perceptual (visual approx), Heretical (lossy shortcuts)
- Key bottleneck is P2G (Particle-to-Grid) transfer with atomicAdd contention
- Morton-sorted workgroups reduce cache thrashing
- TMU exploitation for spatial interpolation
- Raster blending for perceptual accumulation
- Deformation gradient F tracking with SVD-based return mapping
- Billboard sphere splatting → bilateral depth smoothing → Lambert composite rendering

KEY SOLVER ARCHITECTURE:
- src/lib/mpm/mpmSolver.ts: CPU MLS-MPM with Drucker-Prager return mapping
- src/lib/soil/soilSim.ts: Hybrid SDF-MPM soil simulator driving VoxelField
- src/lib/soil/VoxelField.ts: 64x32x64 SDF voxel field with Surface Nets mesh extraction
- src/lib/soil/soilShader.ts: GLSL vertex/fragment shaders with dual-light Lambert + disturbance coloring
- public/soil-lab.html: WebGPU MLS-MPM with WGSL compute shaders (P2G, grid update, G2P passes)

Your analysis job:
1. VISUAL: Describe what you see — particle distribution, terrain shape, artifacts, rendering quality
2. PHYSICS: Identify issues — instability, particle explosion, unrealistic flow, poor piling, boundary artifacts
3. RENDERING: Depth discontinuities, color banding, missing shadows, billboard artifacts, mesh quality
4. RECOMMENDATIONS: Specific, actionable fixes with code-level suggestions referencing actual files
5. RATING: Score physics accuracy (1-10) and visual quality (1-10)
6. SAC ALIGNMENT: How well does the current state align with Substrate-Aligned Computing principles?

Be concise but thorough. Use technical language. Reference specific shader passes, solver parameters, and constitutive models.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { imageBase64, source, metadata, codeContext, docsContext, model, stream } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Build user message with image + context
    const userContent: any[] = [];

    if (imageBase64) {
      userContent.push({
        type: "image_url",
        image_url: {
          url: imageBase64.startsWith("data:")
            ? imageBase64
            : `data:image/png;base64,${imageBase64}`,
        },
      });
    }

    let textPrompt = `Analyzing screenshot from: ${source || "unknown"}\n`;
    if (metadata) {
      textPrompt += `\nSimulation state:\n${JSON.stringify(metadata, null, 2)}\n`;
    }
    if (codeContext) {
      textPrompt += `\nRelevant code:\n\`\`\`\n${codeContext.substring(0, 4000)}\n\`\`\`\n`;
    }
    if (docsContext) {
      textPrompt += `\nAdditional context:\n${docsContext.substring(0, 3000)}\n`;
    }
    textPrompt += `\nAnalyze this simulation screenshot. Provide actionable recommendations.`;
    userContent.push({ type: "text", text: textPrompt });

    const selectedModel = model || "google/gemini-3.1-pro-preview";

    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          max_tokens: 2500,
          stream: !!stream,
        }),
      }
    );

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limited — please try again in a moment." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "Credits exhausted — add funds in Lovable settings." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errText = await response.text();
      console.error("AI gateway error:", response.status, errText);
      throw new Error(`AI gateway returned ${response.status}`);
    }

    // If streaming, pass through the SSE stream
    if (stream) {
      return new Response(response.body, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
      });
    }

    // Non-streaming: parse and return
    const data = await response.json();
    const analysis = data.choices?.[0]?.message?.content || "No analysis generated.";

    return new Response(
      JSON.stringify({ analysis, model: selectedModel }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("analyze-screenshot error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
