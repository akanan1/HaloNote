import { Router, type IRouter } from "express";
import { getSchedule, ScheduleError } from "../lib/ehr-schedule";

const router: IRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/schedule/today", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const practitionerId = user.ehrPractitionerId;
  if (!practitionerId) {
    res.status(409).json({ error: "ehr_not_linked" });
    return;
  }

  // Optional ?date=YYYY-MM-DD. Reject anything else explicitly so the
  // server doesn't silently return today when a malformed value is sent.
  const rawDate = req.query["date"];
  let date: string | undefined;
  if (typeof rawDate === "string" && rawDate.length > 0) {
    if (!DATE_RE.test(rawDate)) {
      res.status(400).json({ error: "invalid_date" });
      return;
    }
    date = rawDate;
  }

  try {
    const data = await getSchedule(practitionerId, date);
    res.json({ data });
  } catch (err) {
    if (err instanceof ScheduleError) {
      req.log.warn(
        { err, practitionerId, status: err.status },
        "schedule fetch failed",
      );
      res.status(err.status).json({ error: "ehr_unavailable" });
      return;
    }
    req.log.error({ err, practitionerId }, "schedule fetch failed");
    res.status(500).json({ error: "internal_server_error" });
  }
});

export default router;
