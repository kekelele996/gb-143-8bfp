import dotenv from 'dotenv';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { createServiceRecord } from '../services/volunteerService';
import { createVolunteer, getVolunteerById } from '../services/volunteerManager';
import { createComplaint, handleComplaint, getComplaintById } from '../services/complaintService';
import { createAppeal, handleAppeal, getAppealById, getAppeals } from '../services/appealService';
import { calculateLevel } from '../services/badgeService';

dotenv.config();

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({
    name,
    passed: condition,
    error: condition ? undefined : error,
    details,
  });
  const status = condition ? '✓ PASS' : '✗ FAIL';
  console.log(`${status} ${name}`);
  if (!condition && error) {
    console.log(`  Error: ${error}`);
  }
  if (details) {
    console.log(`  Details:`, JSON.stringify(details, null, 2));
  }
};

const getLogCounts = async (volunteerId: string) => {
  const client = await pool.connect();
  try {
    const points = await client.query(
      'SELECT COUNT(*) as count FROM points_logs WHERE volunteer_id = $1',
      [volunteerId]
    );
    const credit = await client.query(
      'SELECT COUNT(*) as count FROM credit_logs WHERE volunteer_id = $1',
      [volunteerId]
    );
    return {
      pointsLogs: parseInt(points.rows[0].count),
      creditLogs: parseInt(credit.rows[0].count),
    };
  } finally {
    client.release();
  }
};

const getAuditCount = async (): Promise<number> => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT COUNT(*) as count FROM admin_audit_logs');
    return parseInt(result.rows[0].count);
  } finally {
    client.release();
  }
};

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  志愿者积分与信用评估系统 - 验证用例');
  console.log('  测试场景: 投诉申诉复核闭环');
  console.log('========================================\n');

  try {
    console.log('初始化数据库...');
    await createTables();

    console.log('\n--- 前置条件: 创建志愿者并累积积分 ---');
    const volunteerResult = await createVolunteer('申诉测试-主', '13900000011', 'appeal-main@example.com');
    assert('志愿者创建成功', volunteerResult.success && !!volunteerResult.data, '志愿者创建失败', volunteerResult);
    const volunteerId = volunteerResult.data?.id;

    if (!volunteerId) {
      console.log('\n⚠️  志愿者创建失败，无法继续测试');
      return;
    }

    for (let i = 0; i < 4; i++) {
      await createServiceRecord({
        volunteer_id: volunteerId,
        service_type: 'community_service',
        duration_hours: 2,
        rating: 5,
        description: `申诉测试-服务${i}`,
      });
    }

    const beforeComplaint = await getVolunteerById(volunteerId);
    const basePoints = beforeComplaint.data?.total_points ?? 0;
    const baseCredit = beforeComplaint.data?.credit_score ?? 0;
    const baseLevel = beforeComplaint.data?.level ?? 0;
    assert('服务后积分为116分', basePoints === 116, `期望116分，实际${basePoints}分`, beforeComplaint.data);
    assert('服务后等级为2级', baseLevel === 2, `期望2级，实际${baseLevel}级`, beforeComplaint.data);

    console.log('\n========================================');
    console.log('  场景1: 投诉确认产生积分与信用处罚');
    console.log('========================================');

    const complaint1 = await createComplaint(volunteerId, 'poor_attitude', '服务态度投诉-申诉主流程', undefined);
    assert('投诉1创建成功', complaint1.success === true, '投诉1创建失败', complaint1);
    const complaint1Id = complaint1.data?.id!;

    const complaint2 = await createComplaint(volunteerId, 'other', '待处理投诉-用于负向用例', undefined);
    assert('投诉2创建成功(保持pending)', complaint2.success === true, '投诉2创建失败', complaint2);
    const complaint2Id = complaint2.data?.id!;

    const afterTwoComplaints = await getVolunteerById(volunteerId);
    const creditAfterTwoComplaints = afterTwoComplaints.data?.credit_score ?? 0;
    assert('两条活跃投诉后信用分下降', creditAfterTwoComplaints < baseCredit,
      `期望低于${baseCredit}分，实际${creditAfterTwoComplaints}分`, afterTwoComplaints.data);

    const resolve1 = await handleComplaint(complaint1Id, 'resolve', 'test-admin', '投诉成立，执行处罚', 2);
    assert('投诉1处理成功', resolve1.success === true, '投诉1处理失败', resolve1);
    const pointsPenalty1 = resolve1.data?.pointsPenalty ?? 0;
    assert('投诉1积分处罚为30分(severity=2)', pointsPenalty1 === 30, `期望30分，实际${pointsPenalty1}分`, resolve1.data);

    const afterResolve = await getVolunteerById(volunteerId);
    const pointsAfterResolve = afterResolve.data?.total_points ?? 0;
    const creditAfterResolve = afterResolve.data?.credit_score ?? 0;
    assert('处罚后积分为86分', pointsAfterResolve === basePoints - 30,
      `期望${basePoints - 30}分，实际${pointsAfterResolve}分`, afterResolve.data);
    assert('处罚后等级降为1级', afterResolve.data?.level === 1,
      `期望1级，实际${afterResolve.data?.level}级`, afterResolve.data);
    assert('确认处罚后信用分维持(投诉仍计入)', creditAfterResolve === creditAfterTwoComplaints,
      `期望${creditAfterTwoComplaints}分，实际${creditAfterResolve}分`, afterResolve.data);

    console.log('\n========================================');
    console.log('  场景2: 申诉提交规则');
    console.log('========================================');

    console.log('\n--- 用例2.1: 投诉未确认(pending)不能申诉 ---');
    const appealOnPending = await createAppeal(complaint2Id, '对未确认投诉的申诉', volunteerId, 'volunteer');
    assert('未确认投诉申诉被拒绝', appealOnPending.success === false, 'pending投诉不应允许申诉', appealOnPending);
    assert('返回未确认错误信息', appealOnPending.error === '投诉未确认，无法申请复核',
      `实际错误: ${appealOnPending.error}`, appealOnPending);

    console.log('\n--- 用例2.2: 他人不能代为申诉 ---');
    const appealByOther = await createAppeal(complaint1Id, '他人代提的申诉理由', 'someone-else-id', 'volunteer');
    assert('他人申诉被拒绝', appealByOther.success === false, '非本人不应允许申诉', appealByOther);
    assert('返回越权错误信息', appealByOther.error === '只能为自己的投诉提交申诉',
      `实际错误: ${appealByOther.error}`, appealByOther);

    console.log('\n--- 用例2.3: 本人在七日内申诉成功 ---');
    const appeal1 = await createAppeal(complaint1Id, '处罚过重，申请复核服务态度认定', volunteerId, 'volunteer');
    assert('申诉提交成功', appeal1.success === true, '申诉提交失败', appeal1);
    assert('申诉状态为pending', appeal1.data?.status === 'pending',
      `期望pending，实际${appeal1.data?.status}`, appeal1.data);
    const appeal1Id = appeal1.data?.id!;

    console.log('\n--- 用例2.4: 待处理时不能重复提交 ---');
    const duplicateAppeal = await createAppeal(complaint1Id, '重复提交的申诉理由', volunteerId, 'volunteer');
    assert('重复申诉被拒绝', duplicateAppeal.success === false, '待处理时不应重复提交', duplicateAppeal);
    assert('返回重复提交错误信息', duplicateAppeal.error === '该投诉已有待处理的申诉，请勿重复提交',
      `实际错误: ${duplicateAppeal.error}`, duplicateAppeal);

    console.log('\n--- 用例2.5: 并发提交只成功一次 ---');
    const complaint3 = await createComplaint(volunteerId, 'violation', '并发申诉测试投诉', undefined);
    const complaint3Id = complaint3.data?.id!;
    const resolve3 = await handleComplaint(complaint3Id, 'resolve', 'test-admin', '投诉成立', 1);
    const pointsPenalty3 = resolve3.data?.pointsPenalty ?? 0;
    const concurrentCreates = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createAppeal(complaint3Id, `并发申诉理由${i}-申请复核`, volunteerId, 'volunteer')
      )
    );
    const createSuccessCount = concurrentCreates.filter(r => r.success).length;
    const createDuplicateCount = concurrentCreates.filter(r => r.error === '该投诉已有待处理的申诉，请勿重复提交').length;
    assert('并发提交恰好1个成功', createSuccessCount === 1,
      `期望1个成功，实际${createSuccessCount}个`, concurrentCreates.map(r => ({ success: r.success, error: r.error })));
    assert('其余4个返回重复提交', createDuplicateCount === 4,
      `期望4个重复，实际${createDuplicateCount}个`, concurrentCreates.map(r => ({ success: r.success, error: r.error })));
    const appeal3Id = concurrentCreates.find(r => r.success)?.data?.id!;

    console.log('\n--- 用例2.6: 超过七日不能申诉 ---');
    const complaint4 = await createComplaint(volunteerId, 'other', '超窗申诉测试投诉', undefined);
    const complaint4Id = complaint4.data?.id!;
    await handleComplaint(complaint4Id, 'resolve', 'test-admin', '投诉成立', 1);
    const shiftClient = await pool.connect();
    try {
      await shiftClient.query(
        "UPDATE complaints SET resolved_at = NOW() - INTERVAL '8 days' WHERE id = $1",
        [complaint4Id]
      );
    } finally {
      shiftClient.release();
    }
    const expiredAppeal = await createAppeal(complaint4Id, '超过七日提出的申诉', volunteerId, 'volunteer');
    assert('超窗申诉被拒绝', expiredAppeal.success === false, '超过七日不应允许申诉', expiredAppeal);
    assert('返回超窗错误信息', expiredAppeal.error === '已超出投诉确认后七日的复核申请期限',
      `实际错误: ${expiredAppeal.error}`, expiredAppeal);

    console.log('\n--- 用例2.7: 七日窗口内(第6天)可申诉 ---');
    const complaint5 = await createComplaint(volunteerId, 'other', '窗口边界申诉测试投诉', undefined);
    const complaint5Id = complaint5.data?.id!;
    await handleComplaint(complaint5Id, 'resolve', 'test-admin', '投诉成立', 1);
    const shiftClient2 = await pool.connect();
    try {
      await shiftClient2.query(
        "UPDATE complaints SET resolved_at = NOW() - INTERVAL '6 days' WHERE id = $1",
        [complaint5Id]
      );
    } finally {
      shiftClient2.release();
    }
    const inWindowAppeal = await createAppeal(complaint5Id, '第六天提出的申诉', volunteerId, 'volunteer');
    assert('窗口内申诉成功', inWindowAppeal.success === true, '窗口内应允许申诉', inWindowAppeal);

    console.log('\n========================================');
    console.log('  场景3: 批准申诉 - 撤销处罚并回读一致');
    console.log('========================================');

    const beforeApprove = await getVolunteerById(volunteerId);
    const pointsBeforeApprove = beforeApprove.data?.total_points ?? 0;
    const creditBeforeApprove = beforeApprove.data?.credit_score ?? 0;
    const logsBeforeApprove = await getLogCounts(volunteerId);

    console.log('\n--- 用例3.1: 管理员批准申诉 ---');
    const approve1 = await handleAppeal(appeal1Id, 'approve', 'test-admin', '复核通过，撤销全部处罚');
    assert('申诉批准成功', approve1.success === true, '申诉批准失败', approve1);
    assert('返还积分为30分', approve1.data?.restoredPoints === 30,
      `期望30分，实际${approve1.data?.restoredPoints}分`, approve1.data);

    console.log('\n--- 用例3.2: 刷新后回读一致(投诉/积分/信用/流水) ---');
    const afterApprove = await getVolunteerById(volunteerId);
    assert('积分恢复30分', afterApprove.data?.total_points === pointsBeforeApprove + 30,
      `期望${pointsBeforeApprove + 30}分，实际${afterApprove.data?.total_points}分`, afterApprove.data);
    assert('等级按返还后积分重算', afterApprove.data?.level === calculateLevel(pointsBeforeApprove + 30),
      `期望${calculateLevel(pointsBeforeApprove + 30)}级，实际${afterApprove.data?.level}级`, afterApprove.data);
    assert('信用分回升15分(投诉不再计入)', afterApprove.data?.credit_score === creditBeforeApprove + 15,
      `期望${creditBeforeApprove + 15}分，实际${afterApprove.data?.credit_score}分`, afterApprove.data);

    const complaint1After = await getComplaintById(complaint1Id);
    assert('投诉1标记为revoked', complaint1After.data?.status === 'revoked',
      `期望revoked，实际${complaint1After.data?.status}`, complaint1After.data);

    const appeal1After = await getAppealById(appeal1Id);
    assert('申诉状态为approved', appeal1After.data?.status === 'approved',
      `期望approved，实际${appeal1After.data?.status}`, appeal1After.data);
    assert('申诉记录处理人', appeal1After.data?.handled_by === 'test-admin',
      `期望test-admin，实际${appeal1After.data?.handled_by}`, appeal1After.data);
    assert('申诉记录处理时间', !!appeal1After.data?.resolved_at, 'resolved_at应为非空', appeal1After.data);

    const logsAfterApprove = await getLogCounts(volunteerId);
    assert('积分流水新增1条', logsAfterApprove.pointsLogs === logsBeforeApprove.pointsLogs + 1,
      `期望${logsBeforeApprove.pointsLogs + 1}条，实际${logsAfterApprove.pointsLogs}条`, logsAfterApprove);
    assert('信用流水新增1条', logsAfterApprove.creditLogs === logsBeforeApprove.creditLogs + 1,
      `期望${logsBeforeApprove.creditLogs + 1}条，实际${logsAfterApprove.creditLogs}条`, logsAfterApprove);

    const verifyClient = await pool.connect();
    try {
      const pointsLog = await verifyClient.query(
        "SELECT * FROM points_logs WHERE related_id = $1 AND related_type = 'appeal'",
        [appeal1Id]
      );
      assert('积分流水返还30分', pointsLog.rows.length === 1 && pointsLog.rows[0].change_amount === 30,
        `期望1条+30流水，实际${JSON.stringify(pointsLog.rows)}`, pointsLog.rows);
      assert('积分流水前后余额连续',
        pointsLog.rows.length === 1 &&
        pointsLog.rows[0].before_points === pointsBeforeApprove &&
        pointsLog.rows[0].after_points === pointsBeforeApprove + 30,
        '流水前后余额应与回读一致', pointsLog.rows[0]);

      const creditLog = await verifyClient.query(
        "SELECT * FROM credit_logs WHERE related_id = $1 AND related_type = 'appeal'",
        [appeal1Id]
      );
      assert('信用流水回升15分', creditLog.rows.length === 1 && creditLog.rows[0].change_amount === 15,
        `期望1条+15流水，实际${JSON.stringify(creditLog.rows)}`, creditLog.rows);
      assert('信用流水前后分数连续',
        creditLog.rows.length === 1 &&
        creditLog.rows[0].before_score === creditBeforeApprove &&
        creditLog.rows[0].after_score === creditBeforeApprove + 15,
        '信用流水前后分数应与回读一致', creditLog.rows[0]);

      const auditLog = await verifyClient.query(
        "SELECT * FROM admin_audit_logs WHERE action = 'approve_appeal' AND target_id = $1",
        [appeal1Id]
      );
      assert('审计日志记录批准操作', auditLog.rows.length === 1,
        `期望1条审计日志，实际${auditLog.rows.length}条`, auditLog.rows);
      assert('审计日志记录投诉状态变更',
        auditLog.rows.length === 1 &&
        auditLog.rows[0].new_value?.complaint_status === 'revoked',
        '审计应记录投诉标记为revoked', auditLog.rows[0]?.new_value);
    } finally {
      verifyClient.release();
    }

    console.log('\n--- 用例3.3: 重复处理同一申诉(幂等) ---');
    const logsBeforeRehandle = await getLogCounts(volunteerId);
    const rehandle = await handleAppeal(appeal1Id, 'approve', 'test-admin', '重复批准操作');
    assert('重复处理被拒绝', rehandle.success === false, '已处理申诉不应再次处理', rehandle);
    assert('返回已处理错误信息', rehandle.error === '该申诉已处理',
      `实际错误: ${rehandle.error}`, rehandle);
    const logsAfterRehandle = await getLogCounts(volunteerId);
    assert('重复处理无新增积分流水', logsAfterRehandle.pointsLogs === logsBeforeRehandle.pointsLogs,
      '积分流水不应变化', logsAfterRehandle);
    assert('重复处理无新增信用流水', logsAfterRehandle.creditLogs === logsBeforeRehandle.creditLogs,
      '信用流水不应变化', logsAfterRehandle);
    const afterRehandle = await getVolunteerById(volunteerId);
    assert('重复处理积分不变', afterRehandle.data?.total_points === pointsBeforeApprove + 30,
      '积分不应变化', afterRehandle.data);

    console.log('\n--- 用例3.4: 已撤销的投诉不能再申诉 ---');
    const appealOnRevoked = await createAppeal(complaint1Id, '对已撤销投诉再次申诉', volunteerId, 'volunteer');
    assert('已撤销投诉申诉被拒绝', appealOnRevoked.success === false, 'revoked投诉不应允许申诉', appealOnRevoked);

    console.log('\n========================================');
    console.log('  场景4: 并发处理同一申诉只成功一次');
    console.log('========================================');

    const beforeConcurrent = await getVolunteerById(volunteerId);
    const pointsBeforeConcurrent = beforeConcurrent.data?.total_points ?? 0;

    const concurrentHandles = await Promise.all([
      handleAppeal(appeal3Id, 'approve', 'admin-a', '并发批准A'),
      handleAppeal(appeal3Id, 'approve', 'admin-b', '并发批准B'),
    ]);
    const handleSuccessCount = concurrentHandles.filter(r => r.success).length;
    const handleAlreadyCount = concurrentHandles.filter(r => r.error === '该申诉已处理').length;
    assert('并发处理恰好1个成功', handleSuccessCount === 1,
      `期望1个成功，实际${handleSuccessCount}个`, concurrentHandles.map(r => ({ success: r.success, error: r.error })));
    assert('另1个返回已处理', handleAlreadyCount === 1,
      `期望1个已处理，实际${handleAlreadyCount}个`, concurrentHandles.map(r => ({ success: r.success, error: r.error })));

    const afterConcurrent = await getVolunteerById(volunteerId);
    assert('积分只返还一次', afterConcurrent.data?.total_points === pointsBeforeConcurrent + pointsPenalty3,
      `期望${pointsBeforeConcurrent + pointsPenalty3}分，实际${afterConcurrent.data?.total_points}分`, afterConcurrent.data);

    const concurrentClient = await pool.connect();
    try {
      const appealPointsLogs = await concurrentClient.query(
        "SELECT COUNT(*) as count FROM points_logs WHERE related_id = $1 AND related_type = 'appeal'",
        [appeal3Id]
      );
      assert('该申诉仅1条积分返还流水', parseInt(appealPointsLogs.rows[0].count) === 1,
        `期望1条，实际${appealPointsLogs.rows[0].count}条`, appealPointsLogs.rows[0]);
    } finally {
      concurrentClient.release();
    }

    console.log('\n========================================');
    console.log('  场景5: 拒绝申诉 - 原处罚不变');
    console.log('========================================');

    const complaint6 = await createComplaint(volunteerId, 'misconduct', '拒绝申诉测试投诉', undefined);
    const complaint6Id = complaint6.data?.id!;
    await handleComplaint(complaint6Id, 'resolve', 'test-admin', '投诉成立', 1);

    const beforeReject = await getVolunteerById(volunteerId);
    const pointsBeforeReject = beforeReject.data?.total_points ?? 0;
    const creditBeforeReject = beforeReject.data?.credit_score ?? 0;
    const logsBeforeReject = await getLogCounts(volunteerId);

    const appeal6 = await createAppeal(complaint6Id, '对处罚结果不服申请复核', volunteerId, 'volunteer');
    assert('申诉6提交成功', appeal6.success === true, '申诉6提交失败', appeal6);
    const appeal6Id = appeal6.data?.id!;

    console.log('\n--- 用例5.1: 管理员拒绝申诉 ---');
    const reject6 = await handleAppeal(appeal6Id, 'reject', 'test-admin', '复核维持原处罚决定');
    assert('申诉拒绝成功', reject6.success === true, '申诉拒绝失败', reject6);

    console.log('\n--- 用例5.2: 回读确认原处罚不变 ---');
    const afterReject = await getVolunteerById(volunteerId);
    assert('积分不变', afterReject.data?.total_points === pointsBeforeReject,
      `期望${pointsBeforeReject}分，实际${afterReject.data?.total_points}分`, afterReject.data);
    assert('信用分不变', afterReject.data?.credit_score === creditBeforeReject,
      `期望${creditBeforeReject}分，实际${afterReject.data?.credit_score}分`, afterReject.data);

    const complaint6After = await getComplaintById(complaint6Id);
    assert('投诉仍为resolved', complaint6After.data?.status === 'resolved',
      `期望resolved，实际${complaint6After.data?.status}`, complaint6After.data);

    const appeal6After = await getAppealById(appeal6Id);
    assert('申诉状态为rejected', appeal6After.data?.status === 'rejected',
      `期望rejected，实际${appeal6After.data?.status}`, appeal6After.data);

    const logsAfterReject = await getLogCounts(volunteerId);
    assert('拒绝后无新增积分流水', logsAfterReject.pointsLogs === logsBeforeReject.pointsLogs,
      '积分流水不应变化', logsAfterReject);
    assert('拒绝后无新增信用流水', logsAfterReject.creditLogs === logsBeforeReject.creditLogs,
      '信用流水不应变化', logsAfterReject);

    const rejectAuditClient = await pool.connect();
    try {
      const rejectAudit = await rejectAuditClient.query(
        "SELECT * FROM admin_audit_logs WHERE action = 'reject_appeal' AND target_id = $1",
        [appeal6Id]
      );
      assert('审计日志记录拒绝操作', rejectAudit.rows.length === 1,
        `期望1条审计日志，实际${rejectAudit.rows.length}条`, rejectAudit.rows);
    } finally {
      rejectAuditClient.release();
    }

    console.log('\n--- 用例5.3: 拒绝后窗口期内可再次申诉并最终获批 ---');
    const reAppeal6 = await createAppeal(complaint6Id, '补充新证据再次申请复核', volunteerId, 'volunteer');
    assert('再次申诉成功', reAppeal6.success === true, '拒绝后窗口期内应可再次申诉', reAppeal6);
    const approve6 = await handleAppeal(reAppeal6.data?.id!, 'approve', 'test-admin', '新证据成立，撤销处罚');
    assert('再次申诉获批成功', approve6.success === true, '再次申诉批准失败', approve6);
    const complaint6Final = await getComplaintById(complaint6Id);
    assert('投诉6最终标记为revoked', complaint6Final.data?.status === 'revoked',
      `期望revoked，实际${complaint6Final.data?.status}`, complaint6Final.data);

    console.log('\n========================================');
    console.log('  场景6: 任一步失败全部回滚');
    console.log('========================================');

    const complaint7 = await createComplaint(volunteerId, 'other', '回滚测试投诉', undefined);
    const complaint7Id = complaint7.data?.id!;
    const resolve7 = await handleComplaint(complaint7Id, 'resolve', 'test-admin', '投诉成立', 1);
    const pointsPenalty7 = resolve7.data?.pointsPenalty ?? 0;

    const appeal7 = await createAppeal(complaint7Id, '回滚测试申诉理由', volunteerId, 'volunteer');
    assert('申诉7提交成功', appeal7.success === true, '申诉7提交失败', appeal7);
    const appeal7Id = appeal7.data?.id!;

    const beforeRollback = await getVolunteerById(volunteerId);
    const pointsBeforeRollback = beforeRollback.data?.total_points ?? 0;
    const creditBeforeRollback = beforeRollback.data?.credit_score ?? 0;
    const logsBeforeRollback = await getLogCounts(volunteerId);
    const auditBeforeRollback = await getAuditCount();

    console.log('\n--- 用例6.1: 处理中途失败(超长处理人触发数据库约束) ---');
    const failingHandle = await handleAppeal(appeal7Id, 'approve', 'x'.repeat(150), '触发回滚的批准操作');
    assert('异常处理返回失败', failingHandle.success === false, '约束冲突应导致失败', failingHandle);

    console.log('\n--- 用例6.2: 回读确认全部回滚 ---');
    const afterRollback = await getVolunteerById(volunteerId);
    assert('积分已回滚', afterRollback.data?.total_points === pointsBeforeRollback,
      `期望${pointsBeforeRollback}分，实际${afterRollback.data?.total_points}分`, afterRollback.data);
    assert('信用分已回滚', afterRollback.data?.credit_score === creditBeforeRollback,
      `期望${creditBeforeRollback}分，实际${afterRollback.data?.credit_score}分`, afterRollback.data);

    const complaint7After = await getComplaintById(complaint7Id);
    assert('投诉状态已回滚为resolved', complaint7After.data?.status === 'resolved',
      `期望resolved，实际${complaint7After.data?.status}`, complaint7After.data);

    const appeal7After = await getAppealById(appeal7Id);
    assert('申诉已回滚为pending', appeal7After.data?.status === 'pending',
      `期望pending，实际${appeal7After.data?.status}`, appeal7After.data);

    const logsAfterRollback = await getLogCounts(volunteerId);
    assert('积分流水已回滚', logsAfterRollback.pointsLogs === logsBeforeRollback.pointsLogs,
      '积分流水不应变化', logsAfterRollback);
    assert('信用流水已回滚', logsAfterRollback.creditLogs === logsBeforeRollback.creditLogs,
      '信用流水不应变化', logsAfterRollback);
    const auditAfterRollback = await getAuditCount();
    assert('审计日志已回滚', auditAfterRollback === auditBeforeRollback,
      `期望${auditBeforeRollback}条，实际${auditAfterRollback}条`);

    console.log('\n--- 用例6.3: 回滚后申诉仍可正常处理 ---');
    const retryHandle = await handleAppeal(appeal7Id, 'approve', 'test-admin', '回滚后重试批准');
    assert('回滚后重试成功', retryHandle.success === true, '回滚后应可正常重试', retryHandle);
    const afterRetry = await getVolunteerById(volunteerId);
    assert('重试后积分返还', afterRetry.data?.total_points === pointsBeforeRollback + pointsPenalty7,
      `期望${pointsBeforeRollback + pointsPenalty7}分，实际${afterRetry.data?.total_points}分`, afterRetry.data);

    console.log('\n========================================');
    console.log('  场景7: 申诉查询接口');
    console.log('========================================');

    const appealList = await getAppeals(1, 50, undefined, volunteerId);
    assert('申诉列表查询成功', appealList.success === true, '申诉列表查询失败', appealList);
    assert('申诉列表包含全部申诉', appealList.data?.pagination?.total >= 6,
      `期望>=6条，实际${appealList.data?.pagination?.total}条`, appealList.data?.pagination);

    const pendingList = await getAppeals(1, 50, 'pending', volunteerId);
    const allPending = pendingList.data?.appeals?.every((a: any) => a.status === 'pending');
    assert('按状态过滤生效', pendingList.success === true && allPending,
      '过滤结果应全部为pending', pendingList.data?.appeals?.map((a: any) => a.status));

    console.log('\n========================================');
    console.log('  测试结果汇总');
    console.log('========================================');
    const passed = testResults.filter(r => r.passed).length;
    const failed = testResults.filter(r => !r.passed).length;
    console.log(`总计: ${testResults.length} 个用例`);
    console.log(`通过: ${passed} 个 ✓`);
    console.log(`失败: ${failed} 个 ✗`);

    if (failed > 0) {
      console.log('\n失败用例详情:');
      testResults.filter(r => !r.passed).forEach(r => {
        console.log(`  - ${r.name}`);
        if (r.error) console.log(`    原因: ${r.error}`);
      });
    }

    console.log('\n========================================\n');
    process.exit(failed > 0 ? 1 : 0);

  } catch (error) {
    console.error('测试执行出错:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

runTests();
