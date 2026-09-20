import { ApiResponse, Complaint, ComplaintAppeal } from '../types';
import pool from '../db/pool';
import { calculateLevel } from './badgeService';
import { recalculateCreditScore, logCreditChange } from './creditService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

const APPEAL_WINDOW_DAYS = 7;

const mapAppeal = (row: any, deadline?: Date | null): ComplaintAppeal => ({
  ...row,
  deadline: deadline ?? row.deadline ?? null,
  expired:
    row.status === 'pending' &&
    !!(deadline ?? row.deadline) &&
    new Date(deadline ?? row.deadline) < new Date(),
});

export const createAppeal = async (
  complaintId: string,
  volunteerId: string,
  reason: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const complaintResult = await client.query(
      `SELECT *,
              COALESCE(appeal_deadline, resolved_at + INTERVAL '${APPEAL_WINDOW_DAYS} days') AS appeal_window_end,
              (COALESCE(appeal_deadline, resolved_at + INTERVAL '${APPEAL_WINDOW_DAYS} days') < CURRENT_TIMESTAMP) AS appeal_window_expired
       FROM complaints
       WHERE id = $1
       FOR UPDATE`,
      [complaintId]
    );

    if (complaintResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.notFound };
    }

    const complaint = complaintResult.rows[0] as Complaint & {
      appeal_window_end: Date;
      appeal_window_expired: boolean;
    };

    if (complaint.volunteer_id !== volunteerId) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.appeals.notOwner };
    }

    if (complaint.status !== 'resolved' || complaint.penalty_revoked) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.appeals.notResolved };
    }

    if (complaint.appeal_window_expired) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.appeals.windowExpired };
    }

    const existingResult = await client.query(
      'SELECT status FROM complaint_appeals WHERE complaint_id = $1',
      [complaintId]
    );

    if (existingResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return {
        success: false,
        error:
          existingResult.rows[0].status === 'pending'
            ? messages.appeals.duplicatePending
            : messages.appeals.duplicateFinished,
      };
    }

    const appealResult = await client.query(
      `INSERT INTO complaint_appeals (complaint_id, volunteer_id, reason)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [complaintId, volunteerId, reason]
    );

    await client.query(
      `UPDATE complaints
       SET appeal_status = 'pending'
       WHERE id = $1`,
      [complaintId]
    );

    await client.query('COMMIT');

    return {
      success: true,
      data: {
        appeal: mapAppeal(appealResult.rows[0], complaint.appeal_window_end),
        complaint: {
          id: complaint.id,
          status: complaint.status,
          appeal_status: 'pending',
        },
      },
    };
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      return { success: false, error: messages.appeals.duplicateFinished };
    }
    logger.error(messages.logs.submitAppealFailed, error);
    return { success: false, error: messages.appeals.submitFailed };
  } finally {
    client.release();
  }
};

export const reviewAppeal = async (
  appealId: string,
  decision: 'approve' | 'reject',
  reviewedBy: string,
  reviewNote: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const appealResult = await client.query(
      'SELECT * FROM complaint_appeals WHERE id = $1 FOR UPDATE',
      [appealId]
    );

    if (appealResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.appeals.notFound };
    }

    const appeal = appealResult.rows[0] as ComplaintAppeal;

    if (appeal.status !== 'pending') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.appeals.alreadyReviewed };
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

    if (decision === 'reject') {
      const updatedResult = await client.query(
        `UPDATE complaint_appeals
         SET status = 'rejected', review_note = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND status = 'pending'
         RETURNING *`,
        [reviewNote, reviewedBy, appealId]
      );

      if (updatedResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return { success: false, error: messages.appeals.alreadyReviewed };
      }

      await client.query(
        `UPDATE complaints
         SET appeal_status = 'rejected'
         WHERE id = $1`,
        [complaint.id]
      );

      await client.query(
        `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
         VALUES ($1, 'reject_appeal', 'complaint_appeal', $2, $3, $4, $5)`,
        [
          reviewedBy,
          appealId,
          { appeal_status: 'pending', complaint_status: complaint.status, penalty_revoked: complaint.penalty_revoked },
          { appeal_status: 'rejected', complaint_status: complaint.status, penalty_revoked: complaint.penalty_revoked },
          reviewNote,
        ]
      );

      await client.query('COMMIT');

      return {
        success: true,
        message: messages.appeals.rejected,
        data: {
          appeal: mapAppeal(updatedResult.rows[0]),
          complaint: {
            id: complaint.id,
            status: complaint.status,
            appeal_status: 'rejected',
            penalty_revoked: complaint.penalty_revoked,
          },
        },
      };
    }

    if (complaint.status !== 'resolved' || complaint.penalty_revoked) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.appeals.notResolved };
    }

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [complaint.volunteer_id]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0];

    const originalPenaltyResult = await client.query(
      `SELECT change_amount
       FROM points_logs
       WHERE related_id = $1
         AND related_type = 'complaint'
         AND change_amount < 0
       ORDER BY created_at DESC
       LIMIT 1`,
      [complaint.id]
    );

    const refundPoints =
      originalPenaltyResult.rows.length > 0
        ? Math.abs(Number(originalPenaltyResult.rows[0].change_amount))
        : Number(complaint.points_penalty ?? 0);

    const oldTotalPoints = Number(volunteer.total_points);
    const newTotalPoints = oldTotalPoints + refundPoints;
    const oldLevel = volunteer.level;
    const newLevel = calculateLevel(newTotalPoints);

    const updatedResult = await client.query(
      `UPDATE complaint_appeals
       SET status = 'approved', review_note = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [reviewNote, reviewedBy, appealId]
    );

    if (updatedResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.appeals.alreadyReviewed };
    }

    if (refundPoints > 0) {
      await client.query(
        `UPDATE volunteers
         SET total_points = $1, level = $2
         WHERE id = $3`,
        [newTotalPoints, newLevel, volunteer.id]
      );

      await client.query(
        `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
         VALUES ($1, $2, $3, $4, $5, $6, 'complaint_appeal')`,
        [
          volunteer.id,
          refundPoints,
          `申诉批准-撤销投诉扣分: ${complaint.complaint_type}`,
          oldTotalPoints,
          newTotalPoints,
          appealId,
        ]
      );
    }

    await client.query(
      `UPDATE complaints
       SET status = 'overturned',
           appeal_status = 'approved',
           penalty_revoked = true
       WHERE id = $1`,
      [complaint.id]
    );

    const creditResult = await recalculateCreditScore(complaint.volunteer_id, client);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChange(
        complaint.volunteer_id,
        creditResult.changeAmount,
        '申诉批准-撤销投诉信用处罚',
        creditResult.beforeScore,
        creditResult.afterScore,
        appealId,
        'complaint_appeal',
        client
      );
    }

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, 'approve_appeal', 'complaint_appeal', $2, $3, $4, $5)`,
      [
        reviewedBy,
        appealId,
        {
          complaint_status: complaint.status,
          penalty_revoked: false,
          total_points: oldTotalPoints,
          credit_score: creditResult?.beforeScore ?? volunteer.credit_score,
        },
        {
          complaint_status: 'overturned',
          penalty_revoked: true,
          points_refunded: refundPoints,
          total_points: newTotalPoints,
          level: newLevel,
          credit_score: creditResult?.afterScore ?? volunteer.credit_score,
        },
        reviewNote,
      ]
    );

    await client.query('COMMIT');

    return {
      success: true,
      message: messages.appeals.approved,
      data: {
        appeal: mapAppeal(updatedResult.rows[0]),
        complaint: {
          id: complaint.id,
          status: 'overturned',
          appeal_status: 'approved',
          penalty_revoked: true,
        },
        pointsRefunded: refundPoints,
        oldTotalPoints,
        newTotalPoints,
        oldLevel,
        newLevel,
        creditScore: creditResult?.afterScore,
        creditChange: creditResult?.changeAmount,
        creditBreakdown: creditResult?.breakdown,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.reviewAppealFailed, error);
    return { success: false, error: messages.appeals.reviewFailed };
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
    let query = `
      SELECT a.*,
             c.complaint_type,
             c.status AS complaint_status,
             c.penalty_revoked,
             COALESCE(c.appeal_deadline, c.resolved_at + INTERVAL '${APPEAL_WINDOW_DAYS} days') AS deadline
      FROM complaint_appeals a
      JOIN complaints c ON c.id = a.complaint_id
      WHERE 1=1`;
    let countQuery = 'SELECT COUNT(*) as total FROM complaint_appeals a WHERE 1=1';
    const params: any[] = [];
    const countParams: any[] = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND a.status = $${paramIndex}`;
      countQuery += ` AND a.status = $${paramIndex}`;
      params.push(status);
      countParams.push(status);
      paramIndex++;
    }

    if (volunteerId) {
      query += ` AND a.volunteer_id = $${paramIndex}`;
      countQuery += ` AND a.volunteer_id = $${paramIndex}`;
      params.push(volunteerId);
      countParams.push(volunteerId);
      paramIndex++;
    }

    query += ' ORDER BY a.created_at DESC';

    const countResult = await client.query(countQuery, countParams);

    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(pageSize, offset);

    const result = await client.query(query, params);

    return {
      success: true,
      data: {
        appeals: result.rows.map((row) => {
          const { complaint_type, complaint_status, deadline, ...appeal } = row;
          return {
            ...mapAppeal(appeal, deadline),
            complaint_type,
            complaint_status,
          };
        }),
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
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT a.*,
              c.complaint_type,
              c.status AS complaint_status,
              c.penalty_revoked,
              COALESCE(c.appeal_deadline, c.resolved_at + INTERVAL '${APPEAL_WINDOW_DAYS} days') AS deadline
       FROM complaint_appeals a
       JOIN complaints c ON c.id = a.complaint_id
       WHERE a.id = $1`,
      [appealId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.appeals.notFound };
    }

    const row = result.rows[0];
    const { complaint_type, complaint_status, deadline, ...appeal } = row;

    return {
      success: true,
      data: {
        ...mapAppeal(appeal, deadline),
        complaint_type,
        complaint_status,
      },
    };
  } finally {
    client.release();
  }
};
