import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM_PROMPT = `You are an expert simulation physicist and graphics engineer specializing in:
- MLS-MPM (Moving Least Squares Material Point Method)
- Drucker-Prager elastoplasticity
- WebGPU compute shaders and rendering pipelines
- Real-time physics simulation optimization

You are analyzing a screenshot from a soil/fluid simulation built with WebGPU.

Your job:
1. Describe what you see in the screenshot — particle distribution, terrain shape, visual artifacts, rendering quality
2. Identify potential physics issues — instability, particle explosion, unrealistic flow, poor piling behavior, boundary artifacts
3. Identify rendering issues — depth discontinuities, color banding, missing shadows, billboard artifacts
4. Give specific, actionable recommendations with code-level suggestions where possible
5. Rate the overall quality on a scale of 1-10 for both physics accuracy and visual quality

Be concise but thorough. Use technical language. Reference specific shader passes, solver parameters, or constitutive models when relevant.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { imageBase64, source, metadata, codeContext, docsContext, model } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Build the user message with image + context
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
      textPrompt += `\nSimulation metadata:\n${JSON.stringify(metadata, null, 2)}\n`;
    }
    if (codeContext) {
      textPrompt += `\nRelevant code context:\n\`\`\`\n${codeContext.substring(0, 4000)}\n\`\`\`\n`;
    }
    if (docsContext) {
      textPrompt += `\nProject documentation context:\n${docsContext.substring(0, 3000)}\n`;
    }
    textPrompt += `\nPlease analyze this simulation screenshot and provide recommendations.`;

    userContent.push({ type: "text", text: textPrompt });

    // Use the specified model or default to gemini-3.1-pro for vision
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
          max_tokens: 2000,
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
