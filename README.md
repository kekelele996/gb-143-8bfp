# 志愿者积分与信用评估

记录志愿服务、计算积分信用、处理投诉和生成排行榜的后端服务。

## 快速启动（Docker Compose）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：

- 前端：http://localhost:8243
- 后端健康检查：http://localhost:3243/api/health
- 数据库端口：localhost:5743

停止并清理容器、网络和数据卷：

```bash
docker compose down -v --remove-orphans
```

## 主要功能

- 志愿者档案与服务记录
- 积分、徽章和信用分计算
- 投诉处理、后台调整和排行榜
- 申诉闭环：投诉确认后七日内志愿者可申请复核，管理员批准则撤销对应积分与信用处罚

## 投诉申诉闭环

投诉被确认成立（`resolved`）后进入七日申诉期（截止期记录在投诉的 `appeal_deadline` 字段）：

| 接口 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/v1/complaints/:id/appeals` | 志愿者本人 | 七日内凭理由提交申诉；待处理或已处理期间不能重复提交 |
| `GET /api/v1/complaints/appeals` | 管理员 | 申诉列表（可按 `status`、`volunteer_id` 过滤） |
| `GET /api/v1/complaints/appeals/:id` | 管理员 | 申诉详情 |
| `POST /api/v1/complaints/appeals/:id/review` | 管理员 | `decision=approve` 撤销该投诉的积分与信用处罚；`decision=reject` 仅结束申诉、原处罚不变 |

约束与一致性保证：

- 一条投诉终生只能申诉一次（`complaint_appeals.complaint_id` 唯一索引 + 业务校验）。
- 批准时在单个数据库事务内完成：积分按原始扣分流水等额返还、等级重算、信用分重算（已撤销投诉不再计入信用惩罚）、投诉与申诉状态同步标记（`overturned`/`approved`/`penalty_revoked`）、写入管理员审计日志。
- 审核使用行锁与条件更新（`WHERE status = 'pending'`），重复或并发审核只有一次成功；任一步失败整笔回滚。
- 拒绝申诉只更新申诉状态与审计，不触碰积分和信用分。

## 本地开发

前端：

```bash
cd frontend
npm install
npm run dev
```

后端：

```bash
cd backend
npm install
npm run dev
```

数据库可通过根目录的 Docker Compose 单独启动：

```bash
docker compose up -d db
```

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | Static HTML + Nginx |
| 后端 | Express + TypeScript |
| 数据库 | PostgreSQL |
| 部署 | Docker Compose + Nginx |

## 项目目录结构

```text
.
├── docker-compose.yml
├── .env.example
├── .env
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   └── ...
├── backend/
│   ├── Dockerfile
│   └── ...
└── database/
    └── ...
```

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| COMPOSE_PROJECT_NAME | Compose 项目名，避免中文目录名导致项目名为空 | gb-143 |
| DB_NAME | 数据库名称 | volunteer_db |
| DB_USER | 数据库用户 | volunteer_user |
| DB_PASSWORD | 数据库密码 | volunteer_pass |
| DB_ROOT_PASSWORD | 数据库 root/superuser 密码 | volunteer_root_pwd |
| JWT_SECRET | 后端签名密钥 | volunteer_credit_secret_key_2026 |
| FRONTEND_PORT | 前端宿主机端口 | 8243 |
| BACKEND_PORT | 后端宿主机端口 | 3243 |
| DB_PORT | 数据库宿主机端口 | 5743 |

## Docker 部署说明

- `docker-compose.yml` 顶层已声明 `name: gb-143`，可以在中文目录名下直接运行。
- 数据库使用 Docker 命名卷 `db_data` 持久化，不绑定到宿主中文路径。
- 前端容器使用 Nginx 托管静态资源，并将 `/api` 反向代理到后端服务名 `backend`。
- 后端会等待数据库健康后再启动，前端会等待后端健康后再启动。
- 如本机端口冲突，修改根目录 `.env` 中的 `FRONTEND_PORT`、`BACKEND_PORT` 或 `DB_PORT`。

## License

MIT
