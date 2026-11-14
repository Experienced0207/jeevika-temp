-- Synthetic clinical schema only; run after the canonical migration whitelist.
-- Uses the existing local seedDemo organization and clinician sessions.
INSERT INTO patients (org_id,id,name,birth_date,gender,language,synthetic)
VALUES ('demo','P-1042','P-1042 Synthetic patient','1974-01-01','female','hi-IN',1)
ON CONFLICT(org_id,id) DO NOTHING;

WITH baseline(day,value) AS (
  VALUES (0,124),(1,125),(2,126),(3,124),(4,125),(5,126),(6,124)
), samples AS (
  SELECT value,strftime('%Y-%m-%dT00:00:00.000Z','2026-10-01','+' || day || ' days') AS at FROM baseline
)
INSERT INTO vitalis_observations
  (id,org_id,patient_id,metric_code,metric_name,value_numeric,unit,observed_start_utc,source_type,source_id,source_record_id,quality)
SELECT 'demo:careops:P-1042:' || at,'demo','P-1042','8480-6','Systolic blood pressure',value,'mm[Hg]',at,'manual','careops','careops:P-1042:' || at,'verified'
FROM samples WHERE 1
ON CONFLICT(id) DO NOTHING;
