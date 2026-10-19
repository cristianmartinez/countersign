CREATE INDEX events_send_evidence ON delivery_events(send_id,type,occurred_at DESC,svix_id DESC);
CREATE INDEX events_pending_provider ON delivery_events(resend_email_id) WHERE applied_at IS NULL;
-- Evidence rank is independent of arrival order. failed/suppressed share a public
-- failed state; failed wins their deterministic internal tie. Keep every raw event.
CREATE VIEW delivery_evidence AS
 SELECT send_id,type,substr(type,7) AS delivery_status,
  CASE WHEN type IN ('email.bounced','email.failed','email.suppressed') THEN
   type || ': ' || substr(CASE
    WHEN type='email.bounced' AND json_type(raw,'$.data.bounce.message')='text' THEN json_extract(raw,'$.data.bounce.message')
    WHEN type='email.failed' AND json_type(raw,'$.data.failed.reason')='text' THEN json_extract(raw,'$.data.failed.reason')
    WHEN type='email.suppressed' AND json_type(raw,'$.data.suppressed.message')='text' THEN json_extract(raw,'$.data.suppressed.message')
    ELSE 'Provider reported a negative delivery outcome' END,1,2000)
  ELSE NULL END AS reason
 FROM (
  SELECT *,row_number() OVER (PARTITION BY send_id ORDER BY
   CASE type WHEN 'email.bounced' THEN 5 WHEN 'email.failed' THEN 4
    WHEN 'email.suppressed' THEN 3 WHEN 'email.delivered' THEN 2 WHEN 'email.sent' THEN 1 END DESC,
   occurred_at DESC,svix_id DESC) AS position
  FROM delivery_events WHERE send_id IS NOT NULL AND type IN
   ('email.bounced','email.failed','email.suppressed','email.delivered','email.sent')
 ) WHERE position=1;
UPDATE scaffold_metadata SET schema_version=6 WHERE id=1;
