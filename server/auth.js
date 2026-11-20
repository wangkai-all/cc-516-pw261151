'use strict';
// RBAC：viewer < analyst < approver < admin。身份经 x-user-id 请求头传递（演示环境模拟登录）。

const ROLE_RANK = { viewer: 1, analyst: 2, approver: 3, admin: 4 };

function getUser(db, req) {
  const id = req.headers['x-user-id'] || 'carol'; // 默认只读访客，最安全
  const user = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(id);
  return user || null;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 要求至少某角色
function requireRole(user, minRole) {
  if (!user) throw new HttpError(401, '未认证：请通过 x-user-id 指定用户');
  if ((ROLE_RANK[user.role] || 0) < ROLE_RANK[minRole]) {
    throw new HttpError(403, `权限不足：需要 ${minRole} 及以上角色（当前 ${user.role}）`);
  }
}

module.exports = { getUser, requireRole, HttpError, ROLE_RANK };
