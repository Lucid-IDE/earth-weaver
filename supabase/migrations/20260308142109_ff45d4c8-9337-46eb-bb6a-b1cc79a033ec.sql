
-- Create screenshots table (no auth required - dev tool)
CREATE TABLE public.sim_screenshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  image_url TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'soil',
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  metadata JSONB DEFAULT '{}',
  analysis TEXT,
  model_used TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS but allow all access (dev tool, no auth)
ALTER TABLE public.sim_screenshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read screenshots"
  ON public.sim_screenshots FOR SELECT
  USING (true);

CREATE POLICY "Anyone can insert screenshots"
  ON public.sim_screenshots FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update screenshots"
  ON public.sim_screenshots FOR UPDATE
  USING (true);

CREATE POLICY "Anyone can delete screenshots"
  ON public.sim_screenshots FOR DELETE
  USING (true);

-- Create storage bucket for screenshots
INSERT INTO storage.buckets (id, name, public)
VALUES ('screenshots', 'screenshots', true);

CREATE POLICY "Public read access for screenshots"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'screenshots');

CREATE POLICY "Anyone can upload screenshots"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'screenshots');
