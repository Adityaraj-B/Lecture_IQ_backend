import { Router } from 'express';
import { requireRole } from '../middleware/session.js';
import { professorOverview } from '../services/analytics.js';

/** GET /v1/analytics/overview  (professor) */
export function analyticsRouter({ db }) {
  const router = Router();
  router.get('/overview', requireRole('professor'), (req, res) => {
    const courses = db.coursesOf(req.user);
    res.json(
      professorOverview({
        courses,
        assignments: db.assignmentsInCourses(courses.map((c) => c.id)),
        submissionsOf: (id) => db.submissionsFor(id),
        nameOf: (id) => db.user(id)?.name ?? 'Unknown',
      }),
    );
  });
  return router;
}

/**
 * GET /v1/events: Server-Sent Events stream for the signed-in user.
 * Events: assignment.published, assignment.removed, submission.created, course.joined, course.left.
 */
export function eventsRouter({ hub }) {
  const router = Router();
  router.get('/', (req, res) => {
    res.set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // stop proxies from buffering the stream
    });
    res.flushHeaders();
    res.write('retry: 3000\nevent: ready\ndata: {}\n\n');

    const unsubscribe = hub.subscribe(req.user.id, res);
    // Comment frames keep Render's proxy (and mobile NATs) from dropping an idle connection.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  return router;
}
