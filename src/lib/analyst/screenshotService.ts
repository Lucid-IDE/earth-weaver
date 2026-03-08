import { supabase } from '@/integrations/supabase/client';

export interface Screenshot {
  id: string;
  image_url: string;
  source: string;
  trigger_type: string;
  metadata: Record<string, any>;
  analysis: string | null;
  model_used: string | null;
  created_at: string;
}

/**
 * Upload a base64 screenshot to storage and save a record.
 */
export async function saveScreenshot(
  dataUrl: string,
  source: string,
  triggerType: 'manual' | 'auto',
  metadata: Record<string, any> = {}
): Promise<Screenshot | null> {
  // Convert data URL to blob
  const response = await fetch(dataUrl);
  const blob = await response.blob();

  const filename = `${source}/${Date.now()}.png`;

  // Upload to storage
  const { error: uploadError } = await supabase.storage
    .from('screenshots')
    .upload(filename, blob, { contentType: 'image/png' });

  if (uploadError) {
    console.error('Upload error:', uploadError);
    return null;
  }

  const { data: urlData } = supabase.storage
    .from('screenshots')
    .getPublicUrl(filename);

  // Insert record
  const { data, error } = await supabase
    .from('sim_screenshots')
    .insert({
      image_url: urlData.publicUrl,
      source,
      trigger_type: triggerType,
      metadata,
    })
    .select()
    .single();

  if (error) {
    console.error('Insert error:', error);
    return null;
  }

  return data as Screenshot;
}

/**
 * Fetch all screenshots, newest first.
 */
export async function fetchScreenshots(): Promise<Screenshot[]> {
  const { data, error } = await supabase
    .from('sim_screenshots')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Fetch error:', error);
    return [];
  }

  return (data || []) as Screenshot[];
}

/**
 * Request AI analysis for a screenshot.
 */
export async function analyzeScreenshot(
  screenshot: Screenshot,
  codeContext?: string,
  docsContext?: string,
  model?: string
): Promise<string | null> {
  try {
    // Fetch the image as base64
    const imgResponse = await fetch(screenshot.image_url);
    const imgBlob = await imgResponse.blob();
    const reader = new FileReader();
    const imageBase64 = await new Promise<string>((resolve) => {
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(imgBlob);
    });

    const { data, error } = await supabase.functions.invoke('analyze-screenshot', {
      body: {
        imageBase64,
        source: screenshot.source,
        metadata: screenshot.metadata,
        codeContext,
        docsContext,
        model,
      },
    });

    if (error) {
      console.error('Analysis error:', error);
      return null;
    }

    const analysis = data?.analysis || null;
    const modelUsed = data?.model || model;

    // Save analysis back to the record
    if (analysis) {
      await supabase
        .from('sim_screenshots')
        .update({ analysis, model_used: modelUsed })
        .eq('id', screenshot.id);
    }

    return analysis;
  } catch (e) {
    console.error('Analysis failed:', e);
    return null;
  }
}

/**
 * Delete a screenshot record and its storage file.
 */
export async function deleteScreenshot(screenshot: Screenshot): Promise<boolean> {
  // Extract filename from URL
  const url = new URL(screenshot.image_url);
  const pathParts = url.pathname.split('/screenshots/');
  if (pathParts.length > 1) {
    await supabase.storage.from('screenshots').remove([pathParts[1]]);
  }

  const { error } = await supabase
    .from('sim_screenshots')
    .delete()
    .eq('id', screenshot.id);

  return !error;
}
