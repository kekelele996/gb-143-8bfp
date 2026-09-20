import { ApiResponse, Appeal, Complaint } from '../types';
import pool from '../db/pool';
import { calculateLevel } from './badgeService';
import { logCreditChange, recalculateCreditScore } from './creditService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

export const APPEAL_WINDOW_DAYS = 7;

export const createAppeal = async (
  complaintId: string,
  reason: string,
  requesterId: string,
  requesterRole: 'admin' | 'volunteer'
): Promise<ApiResponse<Appeal>> => {
  const client = await pool.connect();

  try {
    const complaintResult = await client.query(
      'SELECT * FROM complaints WHERE id = $1',
      [complaintId]
    );

    if (complaintResult.rows.length === 0) {
      return { success: false, error: messages.complaints.notFound };
    }

    const complaint = complaintResult.rows[0] as Complaint;

    if (requesterRole === 'volunteer' && complaint.volunteer_id !== requesterId) {
      return { success: false, error: messages.appeals.forbidden };
    }

    if (complaint.status !== 'resolved') {
      return { success: false, error: messages.appeals.complaintNotResolved };
    }

    const windowResult = await client.query(
      `SELECT ($1::timestamp IS NOT NULL AND $1::timestamp >= NOW() - INTERVAL '7 days') AS within_window`,
      [complaint.resolved_at]
    );

    if (!windowResult.rows[0].within_window) {
      return { success: false, error: messages.appeals.windowExpired };
    }

    try {
      const result = await client.query(
        `INSERT INTO appeals (complaint_id, volunteer_id, reason)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [complaintId, complaint.volunteer_id, reason]
      );

      return { success: true, data: result.rows[0] as Appeal };
    } catch (error: any) {
      if (error?.code === '23505') {
        return { success: false, error: messages.appeals.pendingExists };
      }
      throw error;
    }
  } catch (error) {
    logger.error(messages.logs.createAppealFailed, error);
    return { success: false, error: messages.appeals.createFailed };
  } finally {
    client.release();
  }
};

export const getAppeals = async (
  page: number = 1,
  pageSize: number = 20,
  status?: string,
  volunteerId?: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    let query = 'SELECT * FROM appeals WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as total FROM appeals WHERE 1=1';
    const params: any[] = [];
    const countParams: any[] = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND status = $${paramIndex}`;
      countQuery += ` AND status = $${paramIndex}`;
      params.push(status);
      countParams.push(status);
      paramIndex++;
    }

    if (volunteerId) {
      query += ` AND volunteer_id = $${paramIndex}`;
      countQuery += ` AND volunteer_id = $${paramIndex}`;
      params.push(volunteerId);
      countParams.push(volunteerId);
      paramIndex++;
    }

    query += ' ORDER BY created_at DESC';

    const countResult = await client.query(countQuery, countParams);

    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(pageSize, offset);

    const result = await client.query(query, params);

    return {
      success: true,
      data: {
        appeals: result.rows,
        pagination: {
          page,
          page_size: pageSize,
          total: parseInt(countResult.rows[0].total),
          total_pages: Math.ceil(parseInt(countResult.rows[0].total) / pageSize),
        },
      },
    };
  } finally {
    client.release();
  }
};

export const getAppealById = async (
  appealId: string
): Promise<ApiResponse<Appeal>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      'SELECT * FROM appeals WHERE id = $1',
      [appealId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.appeals.notFound };
    }

    return { success: true, data: result.rows[0] };
  } finally {
    client.release();
  }
};

export const handleAppeal = async (
  appealId: string,
  action: 'approve' | 'reject',
  handledBy: string,
  resolution: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const appealResult = await client.query(
      'SELECT * FROM appeals WHERE id = $1 FOR UPDATE',
      [appealId]
    );

    if (appealResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.appeals.notFound };
    }

    const appeal = appealResult.rows[0] as Appeal;

    if (appeal.status !== 'pending') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.appeals.alreadyHandled };
    }

    const complaintResult = await client.query(
      'SELECT * FROM complaints WHERE id = $1 FOR UPDATE',
      [appeal.complaint_id]
    );

    if (complaintResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.notFound };
    }

    const complaint = complaintResult.rows[0] as Complaint;

    if (action === 'reject') {
      await client.query(
        `UPDATE appeals
         SET status = 'rejected', resolution = $1, handled_by = $2, resolved_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [resolution, handledBy, appealId]
      );

      await client.query(
        `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [handledBy, 'reject_appeal', 'appeal', appealId,
         { appeal_status: 'pending' },
         { appeal_status: 'rejected', complaint_id: complaint.id, complaint_status: complaint.status },
         resolution]
      );

      await client.query('COMMIT');

      return {
        success: true,
        message: messages.appeals.rejected,
        data: { appealId, status: 'rejected' },
      };
    }

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [appeal.volunteer_id]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0];

    const restoredPoints = complaint.points_penalty || 0;
    const oldTotalPoints = volunteer.total_points;
    const newTotalPoints = oldTotalPoints + restoredPoints;
    const newLevel = calculateLevel(newTotalPoints);

    await client.query(
      `UPDATE volunteers
       SET total_points = $1, level = $2
       WHERE id = $3`,
      [newTotalPoints, newLevel, volunteer.id]
    );

    if (restoredPoints > 0) {
      await client.query(
        `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [volunteer.id, restoredPoints, `申诉通过-返还投诉扣分: ${complaint.complaint_type}`, oldTotalPoints, newTotalPoints, appealId, 'appeal']
      );
    }

    await client.query(
      `UPDATE complaints
       SET status = 'revoked'
       WHERE id = $1`,
      [complaint.id]
    );

    const creditResult = await recalculateCreditScore(volunteer.id, client);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChange(
        volunteer.id,
        creditResult.changeAmount,
        `申诉通过-信用分重算: ${complaint.complaint_type}`,
        creditResult.beforeScore,
        creditResult.afterScore,
        appealId,
        'appeal',
        client
      );
    }

    await client.query(
      `UPDATE appeals
       SET status = 'approved', resolution = $1, handled_by = $2, resolved_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [resolution, handledBy, appealId]
    );

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [handledBy, 'approve_appeal', 'appeal', appealId,
       {
         complaint_status: complaint.status,
         credit_penalty: complaint.credit_penalty,
         points_penalty: complaint.points_penalty,
         total_points: oldTotalPoints,
       },
       {
         complaint_status: 'revoked',
         restored_points: restoredPoints,
         total_points: newTotalPoints,
         credit_score: creditResult?.afterScore,
       },
       resolution]
    );

    await client.query('COMMIT');

    return {
      success: true,
      message: messages.appeals.approved,
      data: {
        appealId,
        status: 'approved',
        restoredPoints,
        newTotalPoints,
        newLevel,
        creditScore: creditResult?.afterScore,
        creditChange: creditResult?.changeAmount,
        creditBreakdown: creditResult?.breakdown,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.handleAppealFailed, error);
    return { success: false, error: messages.appeals.handleFailed };
  } finally {
    client.release();
  }
};
