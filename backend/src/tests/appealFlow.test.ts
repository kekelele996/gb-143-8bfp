/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
// 运行时需通过环境变量指定嵌入式 PG（pool.ts 在模块加载时读取）：
// DB_HOST=localhost DB_PORT=5743 DB_NAME=volunteer_db DB_USER=postgres DB_PASSWORD=postgres
// eslint-disable-next-line @typescript-eslint/no-var-requires
const EmbeddedPostgres = require('embedded-postgres').default;
import path from 'path';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import {
  createVolunteer,
  getVolunteerById,
  getVolunteerPointsLogs,
  getVolunteerCreditLogs,
} from '../services/volunteerManager';
import { createComplaint, handleComplaint, getComplaintById } from '../services/complaintService';
import { createAppeal, reviewAppeal, getAppeals, getAppealById } from '../services/appealService';
import { recalculateCreditScore } from '../services/creditService';

const results: { name: string; passed: boolean; section: string }[] = [];
let section = '';

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  const ok = !!condition;
  results.push({ name, passed: ok, section });
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'} [${section}] ${name}`);
  if (!ok) {
    console.log(`  Error: ${error}`);
    if (details !== undefined) console.log('  Details:', JSON.stringify(details));
  }
};

const run = async (): Promise<void> => {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join('/tmp', 'pg-appeal-data'),
    user: 'postgres',
    password: 'postgres',
    port: 5743,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('volunteer_db');

  await createTables();

  // ---------- 前置：志愿者 + 投诉确认成立 ----------
  section = '前置';
  const v = await createVolunteer('申诉测试志愿者', '13900000099', 'appeal@example.com');
  const volunteerId = v.data!.id!;

  await pool.query(
    `UPDATE volunteers SET total_points = 650, level = 4, service_count = 10 WHERE id = $1`,
    [volunteerId]
  );

  const c = await createComplaint(volunteerId, 'no_show', '测试用例-投诉爽约行为描述', undefined);
  assert('投诉创建成功', c.success === true, '投诉创建失败', c);
  const complaintId = c.data!.id;

  const resolved = await handleComplaint(complaintId, 'resolve', 'admin', '投诉确认成立-测试用例', 1);
  assert('投诉确认成立', resolved.success === true, '投诉确认失败', resolved);
  const penaltyPoints = resolved.data!.pointsPenalty;
  assert('确认时扣减积分', penaltyPoints > 0, '应有积分扣减', resolved.data);

  const complaintRow0 = (await getComplaintById(complaintId)).data!;
  assert('确认时生成七日申诉截止期', !!complaintRow0.appeal_deadline, '缺少 appeal_deadline', complaintRow0);
  const windowDays =
    (new Date(complaintRow0.appeal_deadline as Date).getTime() -
      new Date(complaintRow0.resolved_at as Date).getTime()) /
    86400000;
  assert('截止期为7天后', windowDays > 6.9, `截止期不是7天: ${windowDays}`, complaintRow0);

  const vAfterResolve = (await getVolunteerById(volunteerId)).data!;
  const creditAfterResolve = vAfterResolve.credit_score;
  assert('确认后信用分已下降', creditAfterResolve < 100, `信用分应<100, 实际${creditAfterResolve}`);

  // ---------- 场景1：七日内可提交申诉 ----------
  section = '提交申诉';
  const appeal = await createAppeal(complaintId, volunteerId, '测试用例-申诉理由：当日有不可抗力导致迟到');
  assert('申诉提交成功', appeal.success === true, '申诉提交失败', appeal);
  const appealId = appeal.data!.appeal.id;
  assert('申诉初始状态为pending', appeal.data!.appeal.status === 'pending', '状态错误', appeal.data);
  assert('返回截止期字段', !!appeal.data!.appeal.deadline, '缺少deadline', appeal.data);
  assert('投诉被同步标记为申诉中', appeal.data!.complaint.appeal_status === 'pending', '投诉 appeal_status 错误', appeal.data);

  // ---------- 场景2：待处理时不能重复提交 ----------
  const dup = await createAppeal(complaintId, volunteerId, '测试用例-重复申诉理由内容');
  assert('待处理期间重复提交被拒绝', dup.success === false, '应拒绝重复申诉', dup);
  assert('重复提交提示明确', dup.error === '已有待处理的申诉，不能重复提交', '提示错误', dup.error);
  const dupCount = (
    await pool.query('SELECT COUNT(*)::int AS n FROM complaint_appeals WHERE complaint_id = $1', [complaintId])
  ).rows[0].n;
  assert('重复提交未产生第二条申诉', dupCount === 1, `申诉条数: ${dupCount}`);

  const cWhilePending = (await getComplaintById(complaintId)).data!;
  assert('申诉期间投诉仍为resolved', cWhilePending.status === 'resolved', '投诉状态被篡改', cWhilePending);
  assert('详情接口附带申诉', cWhilePending.appeal?.status === 'pending', '缺少申诉信息', cWhilePending);

  // ---------- 场景3：申诉列表可查询 ----------
  section = '申诉查询';
  const list = await getAppeals(1, 20, 'pending');
  assert('管理员可按pending列出申诉', list.success === true && list.data!.appeals.some((a: any) => a.id === appealId), '列表未包含申诉', list.data);
  const one = await getAppealById(appealId);
  assert('申诉详情可查', one.success === true && one.data!.complaint_type === 'no_show', '申诉详情错误', one);

  // ---------- 场景4：并发审核只成功一次 ----------
  section = '并发处理';
  const [r1, r2] = await Promise.all([
    reviewAppeal(appealId, 'approve', 'admin', '测试用例-并发审核请求一号'),
    reviewAppeal(appealId, 'approve', 'admin', '测试用例-并发审核请求二号'),
  ]);
  const approveWinners = [r1, r2].filter((r) => r.success);
  assert('并发批准仅一次成功', approveWinners.length === 1, `成功次数应为1, 实际${approveWinners.length}`, { r1: r1.error, r2: r2.error });
  const loser = [r1, r2].find((r) => !r.success);
  assert('失败方得到明确提示', !!loser && loser.error === '该申诉已处理，不能重复审核', '失败提示错误', loser);

  // ---------- 场景5：批准后撤销处罚并同步标记 ----------
  section = '批准撤销';
  const finalComplaint = (await getComplaintById(complaintId)).data!;
  assert('投诉状态变为overturned', finalComplaint.status === 'overturned', `状态错误: ${finalComplaint.status}`, finalComplaint);
  assert('投诉appeal_status=approved', finalComplaint.appeal_status === 'approved', 'appeal_status错误', finalComplaint);
  assert('投诉penalty_revoked=true', finalComplaint.penalty_revoked === true, 'penalty_revoked错误', finalComplaint);

  const vFinal = (await getVolunteerById(volunteerId)).data!;
  assert('积分已回退', vFinal.total_points === 650, `积分应回到650, 实际${vFinal.total_points}`, vFinal.total_points);
  assert('等级随积分恢复', vFinal.level === 4, `等级应恢复为4, 实际${vFinal.level}`, vFinal.level);
  assert('信用处罚已撤销', vFinal.credit_score > creditAfterResolve, `信用分应恢复(${creditAfterResolve} -> ${vFinal.credit_score})`);

  const pointsLogs = (await getVolunteerPointsLogs(volunteerId, 1, 50)).data!.logs;
  const penaltyLog = pointsLogs.find((l: any) => l.related_id === complaintId && l.change_amount < 0);
  const refundLog = pointsLogs.find((l: any) => l.related_id === appealId && l.change_amount > 0);
  assert('积分流水保留原始扣分', !!penaltyLog, '缺少扣分流水', pointsLogs.map((l: any) => l.reason));
  assert('积分流水新增等额返还', !!refundLog && refundLog.change_amount === penaltyPoints, '缺少返还流水或金额不等', { refundLog, penaltyPoints });
  assert('返还流水金额守恒', penaltyLog.change_amount + refundLog.change_amount === 0, '扣分与返还不守恒');

  const creditLogs = (await getVolunteerCreditLogs(volunteerId, 1, 50)).data!.logs;
  assert(
    '信用流水记录撤销变化',
    creditLogs.some((l: any) => l.related_type === 'complaint_appeal' && l.related_id === appealId && l.change_amount > 0),
    '缺少信用撤销流水',
    creditLogs.map((l: any) => l.reason)
  );

  const audit = await pool.query(`SELECT action FROM admin_audit_logs WHERE target_id = $1 ORDER BY created_at`, [appealId]);
  assert('审计记录批准动作', audit.rows.some((r) => r.action === 'approve_appeal'), '缺少 approve_appeal 审计', audit.rows);

  // ---------- 场景6：批准后不能再处理/再申诉 ----------
  const again = await reviewAppeal(appealId, 'reject', 'admin', '测试用例-批准后再尝试驳回');
  assert('已审核申诉再次处理被拒', again.success === false && again.error === '该申诉已处理，不能重复审核', '应拒绝', again);
  const appealAgain = await createAppeal(complaintId, volunteerId, '测试用例-再次申诉理由内容文本');
  assert('终态投诉不能再次申诉', appealAgain.success === false, '应拒绝再次申诉', appealAgain);

  // ---------- 场景7：刷新回读一致 ----------
  section = '一致性';
  const recalc = await recalculateCreditScore(volunteerId);
  assert('刷新重算信用分不漂移', recalc!.afterScore === vFinal.credit_score, `重算${recalc!.afterScore} 与库中${vFinal.credit_score}不一致`, recalc);
  assert('重算时已撤销投诉不计惩罚', recalc!.breakdown.details.activeComplaintCount === 0, '活跃投诉计数应排除已撤销', recalc!.breakdown);

  const relatedSum = (
    await pool.query(
      `SELECT COALESCE(SUM(change_amount),0)::int AS s FROM points_logs
       WHERE volunteer_id=$1 AND ((related_id=$2 AND related_type='complaint') OR (related_id=$3 AND related_type='complaint_appeal'))`,
      [volunteerId, complaintId, appealId]
    )
  ).rows[0].s;
  assert('该投诉相关积分流水净额为0', relatedSum === 0, `净额应为0, 实际${relatedSum}`);

  // ---------- 场景8：拒绝申诉只结束申诉，原处罚不变 ----------
  section = '拒绝申诉';
  const v2 = await createVolunteer('申诉拒绝测试志愿者', '13800000088', 'appeal2@example.com');
  await pool.query(`UPDATE volunteers SET total_points = 650, level = 4, service_count = 10 WHERE id = $1`, [v2.data!.id]);
  const c2 = await createComplaint(v2.data!.id, 'poor_attitude', '测试用例-第二个投诉态度问题', undefined);
  await handleComplaint(c2.data!.id, 'resolve', 'admin', '投诉确认成立-测试用例二', 1);
  const v2AfterResolve = (await getVolunteerById(v2.data!.id)).data!;
  const credit2 = v2AfterResolve.credit_score;
  const points2 = v2AfterResolve.total_points;

  const a2 = await createAppeal(c2.data!.id, v2.data!.id, '测试用例-第二条申诉理由内容');
  assert('第二条申诉提交成功', a2.success === true, '提交失败', a2);

  const rejected = await reviewAppeal(a2.data!.appeal.id, 'reject', 'admin', '测试用例-申诉理由不成立予以驳回');
  assert('拒绝申诉成功', rejected.success === true && rejected.message === '申诉已驳回，原处罚保持不变', '拒绝失败', rejected);

  const c2Final = (await getComplaintById(c2.data!.id)).data!;
  assert('拒绝后投诉仍为resolved', c2Final.status === 'resolved', `状态不应改变: ${c2Final.status}`, c2Final);
  assert('拒绝后appeal_status=rejected', c2Final.appeal_status === 'rejected', 'appeal_status错误', c2Final);
  assert('拒绝后penalty_revoked保持false', c2Final.penalty_revoked === false, '不应撤销处罚', c2Final);

  const v2Final = (await getVolunteerById(v2.data!.id)).data!;
  assert('拒绝后积分不变', v2Final.total_points === points2, `积分${points2} -> ${v2Final.total_points}`);
  assert('拒绝后信用分不变', v2Final.credit_score === credit2, `信用${credit2} -> ${v2Final.credit_score}`);

  const noRefund = await pool.query(
    `SELECT COUNT(*)::int AS n FROM points_logs WHERE volunteer_id=$1 AND related_type='complaint_appeal'`,
    [v2.data!.id]
  );
  assert('拒绝不产生积分返还流水', noRefund.rows[0].n === 0, '不应有返还流水');
  const audit2 = await pool.query(`SELECT action FROM admin_audit_logs WHERE target_id = $1`, [a2.data!.appeal.id]);
  assert('拒绝写入审计', audit2.rows.some((r) => r.action === 'reject_appeal'), '缺少 reject_appeal 审计', audit2.rows);

  const rejectAgain = await reviewAppeal(a2.data!.appeal.id, 'approve', 'admin', '测试用例-拒绝后再尝试批准');
  assert('已拒绝申诉不能再处理', rejectAgain.success === false, '应拒绝', rejectAgain);

  // ---------- 场景9：非本人不能申诉 ----------
  section = '权限';
  const other = await createAppeal(c2.data!.id, volunteerId, '测试用例-非本人提交的申诉理由文本');
  assert('非本人申诉被拒绝', other.success === false && other.error === '只能为本人的投诉提交申诉', '应拒绝非本人', other);

  // ---------- 场景10：未确认/被驳回的投诉不能申诉 ----------
  section = '申诉资格';
  const c3 = await createComplaint(volunteerId, 'other', '测试用例-第三个投诉其他类型内容', undefined);
  const appealPending = await createAppeal(c3.data!.id, volunteerId, '测试用例-对未处理投诉的申诉理由');
  assert('pending投诉不能申诉', appealPending.success === false && appealPending.error === '只有投诉确认成立后的投诉才能申诉', '应拒绝', appealPending);
  await handleComplaint(c3.data!.id, 'reject', 'admin', '测试用例-投诉不成立予以驳回');
  const appealRejectedComplaint = await createAppeal(c3.data!.id, volunteerId, '测试用例-对被驳回投诉的申诉理由');
  assert('rejected投诉不能申诉', appealRejectedComplaint.success === false, '应拒绝', appealRejectedComplaint);

  // ---------- 场景11：超过七日不能申诉 ----------
  section = '申诉期限';
  const v4 = await createVolunteer('超期测试志愿者', '13800000077', 'appeal3@example.com');
  await pool.query(`UPDATE volunteers SET total_points = 200, level = 3 WHERE id = $1`, [v4.data!.id]);
  const c4 = await createComplaint(v4.data!.id, 'other', '测试用例-第四个投诉超期场景内容', undefined);
  await handleComplaint(c4.data!.id, 'resolve', 'admin', '投诉确认成立-超期场景用例', 1);
  await pool.query(
    `UPDATE complaints SET resolved_at = CURRENT_TIMESTAMP - INTERVAL '8 days', appeal_deadline = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE id = $1`,
    [c4.data!.id]
  );
  const expired = await createAppeal(c4.data!.id, v4.data!.id, '测试用例-超过七日才提交的申诉理由');
  assert('超过七日申诉被拒绝', expired.success === false && expired.error === '已超过投诉确认后七日的申诉期限', '应拒绝超期申诉', expired);
  const expiredCount = (
    await pool.query('SELECT COUNT(*)::int AS n FROM complaint_appeals WHERE complaint_id=$1', [c4.data!.id])
  ).rows[0].n;
  assert('超期不产生申诉记录', expiredCount === 0, '不应有记录');

  const listAll = await getAppeals(1, 50);
  assert('列表接口分页统计正常', listAll.data!.pagination.total >= 2, '总数不对', listAll.data!.pagination);

  // ---------- 场景12：任一步失败全部回滚 ----------
  section = '事务回滚';
  const v5 = await createVolunteer('回滚测试志愿者', '13800000066', 'rollback@example.com');
  await pool.query(`UPDATE volunteers SET total_points = 200, level = 3, service_count = 5 WHERE id = $1`, [v5.data!.id]);
  const c5 = await createComplaint(v5.data!.id, 'other', '测试用例-第五个投诉回滚场景内容', undefined);
  await handleComplaint(c5.data!.id, 'resolve', 'admin', '投诉确认成立-回滚场景用例', 1);
  const a5 = await createAppeal(c5.data!.id, v5.data!.id, '测试用例-回滚场景的申诉理由文本');
  // 并发另一会话已先行撤销：直接拨成终态后再批准，必须整笔回滚
  await pool.query(`UPDATE complaints SET penalty_revoked = true, status = 'overturned' WHERE id = $1`, [c5.data!.id]);
  const badApprove = await reviewAppeal(a5.data!.appeal.id, 'approve', 'admin', '测试用例-对异常状态的批准操作');
  assert('异常状态下批准失败', badApprove.success === false, '应失败', badApprove);
  const a5Row = (await pool.query('SELECT status FROM complaint_appeals WHERE id=$1', [a5.data!.appeal.id])).rows[0];
  assert('失败后申诉保持pending(回滚)', a5Row.status === 'pending', `申诉不应被改动: ${a5Row.status}`, a5Row);
  const strayRefund = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM points_logs WHERE volunteer_id=$1 AND related_type='complaint_appeal'`,
      [v5.data!.id]
    )
  ).rows[0].n;
  assert('失败不产生任何返还流水(回滚)', strayRefund === 0, '不应有流水', strayRefund);
  const strayAudit = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM admin_audit_logs WHERE target_id=$1 AND action='approve_appeal'`,
      [a5.data!.appeal.id]
    )
  ).rows[0].n;
  assert('失败不写批准审计(回滚)', strayAudit === 0, '不应有审计');

  await pool.end();
  await pg.stop();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n========================================`);
  console.log(`总计 ${results.length} | 通过 ${passed} | 失败 ${failed}`);
  if (failed > 0) {
    results.filter((r) => !r.passed).forEach((r) => console.log(`  ✗ [${r.section}] ${r.name}`));
  }
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
