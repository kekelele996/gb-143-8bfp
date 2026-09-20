import { Router, Request, Response } from 'express';
import { validateRequest, validateQuery, complaintSchema, handleComplaintSchema, createAppealSchema, reviewAppealSchema, paginationSchema } from '../middleware/validator';
import {
  createComplaint,
  getComplaints,
  handleComplaint,
  getComplaintById,
} from '../services/complaintService';
import {
  createAppeal,
  reviewAppeal,
  getAppeals,
  getAppealById,
} from '../services/appealService';
import { AuthRequest, requireAdmin } from '../middleware/auth';
import { sendInternalError } from '../utils/httpResponses';

const router = Router();

router.post('/', validateRequest(complaintSchema), async (req: Request, res: Response) => {
  try {
    const result = await createComplaint(
      req.body.volunteer_id,
      req.body.complaint_type,
      req.body.description,
      req.body.complainant_id
    );
    const statusCode = result.success ? 201 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error creating complaint');
  }
});

router.get('/appeals', requireAdmin, validateQuery(paginationSchema), async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const status = req.query.status as string;
    const volunteerId = req.query.volunteer_id as string;
    const result = await getAppeals(page, pageSize, status, volunteerId);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting appeals');
  }
});

router.post('/appeals/:id/review', requireAdmin, validateRequest(reviewAppealSchema), async (req: AuthRequest, res: Response) => {
  try {
    const reviewedBy = req.user?.id || 'admin';
    const result = await reviewAppeal(
      req.params.id,
      req.body.decision,
      reviewedBy,
      req.body.review_note
    );
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error reviewing appeal');
  }
});

router.get('/appeals/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const result = await getAppealById(req.params.id);
    const statusCode = result.success ? 200 : 404;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting appeal');
  }
});

router.get('/', validateQuery(paginationSchema), async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const status = req.query.status as string;
    const volunteerId = req.query.volunteer_id as string;
    const result = await getComplaints(page, pageSize, status, volunteerId);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting complaints');
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await getComplaintById(req.params.id);
    const statusCode = result.success ? 200 : 404;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting complaint');
  }
});

router.post('/:id/handle', validateRequest(handleComplaintSchema), async (req: AuthRequest, res: Response) => {
  try {
    const handledBy = req.user?.id || 'admin';
    const result = await handleComplaint(
      req.params.id,
      req.body.action,
      handledBy,
      req.body.resolution,
      req.body.severity
    );
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error handling complaint');
  }
});

router.post('/:id/appeals', validateRequest(createAppealSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, error: '需要认证' });
      return;
    }
    const result = await createAppeal(
      req.params.id,
      req.user.id,
      req.body.reason
    );
    const statusCode = result.success ? 201 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error creating appeal');
  }
});

export default router;
