import { Router, Response } from 'express';
import { validateRequest, validateQuery, handleAppealSchema, paginationSchema } from '../middleware/validator';
import { getAppeals, getAppealById, handleAppeal } from '../services/appealService';
import { AuthRequest, requireAdmin } from '../middleware/auth';
import { sendInternalError } from '../utils/httpResponses';

const router = Router();

router.get('/', validateQuery(paginationSchema), async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const status = req.query.status as string;
    let volunteerId = req.query.volunteer_id as string;
    if (req.user?.role === 'volunteer') {
      volunteerId = req.user.id;
    }
    const result = await getAppeals(page, pageSize, status, volunteerId);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting appeals');
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await getAppealById(req.params.id);
    const statusCode = result.success ? 200 : 404;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting appeal');
  }
});

router.post('/:id/handle', requireAdmin, validateRequest(handleAppealSchema), async (req: AuthRequest, res: Response) => {
  try {
    const handledBy = req.user?.id || 'admin';
    const result = await handleAppeal(
      req.params.id,
      req.body.action,
      handledBy,
      req.body.resolution
    );
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error handling appeal');
  }
});

export default router;
