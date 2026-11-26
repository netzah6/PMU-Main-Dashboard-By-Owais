-- E-signature agreements (11/26/2026). One row per signing link the sales
-- team creates. The agreement text is FROZEN in `content` when the link is
-- made and fingerprinted (content_sha256); signing re-checks that hash so the
-- client always signs exactly what was sent. Everything the signed copy and
-- its Signature Certificate page show (viewed / signed time, IP, location,
-- device, consent) is kept here.
--
-- RLS on with NO policies: only the service role (API routes) reads or
-- writes. The public signing page goes through /api/sign/<token>.
-- Idempotent — safe to run again.

CREATE TABLE IF NOT EXISTS agreement_signatures (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,                     -- 32 random bytes, base64url
  template TEXT NOT NULL CHECK (template IN ('standard', 'ppa')),
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,      -- the numbers the salesperson typed
  content JSONB NOT NULL,                         -- frozen rendered agreement
  content_sha256 TEXT NOT NULL,
  partner_name TEXT NOT NULL,
  partner_email TEXT NOT NULL,
  partner_phone TEXT,
  ghl_contact_id TEXT,
  ghl_note TEXT,                                  -- what happened with the GHL note
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'viewed', 'signed', 'void')),
  viewed_at TIMESTAMPTZ,
  view_ip TEXT,
  view_user_agent TEXT,
  signed_at TIMESTAMPTZ,
  signer_name TEXT,
  signer_email TEXT,
  signer_ip TEXT,
  signer_location TEXT,                           -- "City, Region, Country" from Vercel geo headers
  signer_user_agent TEXT,
  signer_timezone TEXT,
  signature_method TEXT CHECK (signature_method IN ('drawn', 'typed')),
  signature_png TEXT,                             -- storage path in agreement-signatures
  consent_text TEXT,
  signed_pdf_path TEXT,
  signed_pdf_sha256 TEXT,
  voided_at TIMESTAMPTZ,
  voided_by TEXT
);
ALTER TABLE agreement_signatures ADD COLUMN IF NOT EXISTS ghl_note TEXT;
ALTER TABLE agreement_signatures ADD COLUMN IF NOT EXISTS view_user_agent TEXT;
ALTER TABLE agreement_signatures ADD COLUMN IF NOT EXISTS signer_timezone TEXT;
ALTER TABLE agreement_signatures ADD COLUMN IF NOT EXISTS signature_method TEXT;

CREATE INDEX IF NOT EXISTS agreement_signatures_created_idx ON agreement_signatures (created_at DESC);
CREATE INDEX IF NOT EXISTS agreement_signatures_creator_idx ON agreement_signatures (created_by, created_at DESC);

ALTER TABLE agreement_signatures ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: anon / authenticated get nothing.

-- Private bucket for signature images and signed PDFs (the code also creates
-- it on first use if this part was skipped).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('agreement-signatures', 'agreement-signatures', false, 10485760, ARRAY['image/png', 'application/pdf'])
ON CONFLICT (id) DO UPDATE SET public = false;
