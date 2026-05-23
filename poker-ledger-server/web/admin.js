const state = {
  csrfToken: "",
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1,
  q: "",
  users: [],
  editingOpenId: "",
  loading: false
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

function bindElements() {
  for (const id of [
    "loginView",
    "adminView",
    "loginForm",
    "loginUsername",
    "loginPassword",
    "loginSubmit",
    "loginError",
    "logoutButton",
    "refreshButton",
    "searchForm",
    "searchInput",
    "searchSubmit",
    "createUserButton",
    "tableAlert",
    "usersBody",
    "paginationInfo",
    "prevPageButton",
    "nextPageButton",
    "userModal",
    "modalTitle",
    "modalCloseButton",
    "modalCancelButton",
    "userForm",
    "userOpenId",
    "userNickName",
    "userDisplayName",
    "userAvatarUrl",
    "modalError",
    "modalSubmitButton"
  ]) {
    els[id] = $(id);
  }
}

function setBusy(button, busy, text) {
  if (!button) return;
  button.disabled = !!busy;
  if (text) button.textContent = text;
}

function showLoginError(message) {
  els.loginError.textContent = message || "";
  els.loginError.classList.toggle("hidden", !message);
}

function showModalError(message) {
  els.modalError.textContent = message || "";
  els.modalError.classList.toggle("hidden", !message);
}

function showTableAlert(message, type) {
  els.tableAlert.textContent = message || "";
  els.tableAlert.className = "mb-4 hidden rounded-md px-3 py-2 text-sm";
  if (!message) return;

  els.tableAlert.classList.remove("hidden");
  if (type === "error") {
    els.tableAlert.classList.add("bg-red-50", "text-red-700");
    return;
  }
  els.tableAlert.classList.add("bg-emerald-50", "text-emerald-700");
}

function setAuthenticated(authenticated) {
  els.loginView.classList.toggle("hidden", authenticated);
  els.loginView.classList.toggle("flex", !authenticated);
  els.adminView.classList.toggle("hidden", !authenticated);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  const n = Number(value || 0);
  if (!n) return "-";
  return new Date(n).toLocaleString("zh-CN", { hour12: false });
}

function maskOpenId(openId) {
  const s = String(openId || "");
  if (s.length <= 10) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

/**
 * 后台 API 统一请求封装：自动携带 Cookie 和 CSRF token。
 *
 * @param {string} path
 * @param {RequestInit & { bodyJson?: any }} options
 */
async function adminApi(path, options) {
  const opts = options || {};
  const method = String(opts.method || "GET").toUpperCase();
  const headers = {
    Accept: "application/json",
    ...(opts.headers || {})
  };

  if (opts.bodyJson !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && state.csrfToken) {
    headers["X-CSRF-Token"] = state.csrfToken;
  }

  const res = await fetch(`/admin/api${path}`, {
    ...opts,
    method,
    headers,
    credentials: "same-origin",
    body: opts.bodyJson === undefined ? opts.body : JSON.stringify(opts.bodyJson)
  });
  const data = await res.json().catch(() => ({ ok: false, message: "服务返回异常" }));

  if (res.status === 401) {
    state.csrfToken = "";
    setAuthenticated(false);
  }
  if (!data.ok) {
    throw new Error(data.message || "请求失败");
  }
  return data;
}

function renderUsers() {
  if (state.loading) {
    els.usersBody.innerHTML = `
      <tr>
        <td class="px-4 py-8 text-center text-zinc-500" colspan="6">加载中...</td>
      </tr>
    `;
    return;
  }

  if (!state.users.length) {
    els.usersBody.innerHTML = `
      <tr>
        <td class="px-4 py-8 text-center text-zinc-500" colspan="6">暂无用户</td>
      </tr>
    `;
    return;
  }

  els.usersBody.innerHTML = state.users
    .map((user) => {
      const currentRoom = user.currentRoom
        ? `<span class="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">${escapeHtml(user.currentRoom.roomCode)} · ${escapeHtml(user.currentRoom.role)}</span>`
        : `<span class="text-zinc-400">-</span>`;
      const avatar = user.avatarUrlWx
        ? `<img class="h-9 w-9 rounded-full object-cover" src="${escapeHtml(user.avatarUrlWx)}" alt="" />`
        : `<div class="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-600">无</div>`;
      const name = user.displayName || user.nickNameWx || "未命名";

      return `
        <tr class="hover:bg-zinc-50">
          <td class="px-4 py-3">
            <div class="flex items-center gap-3">
              ${avatar}
              <div class="min-w-0">
                <p class="truncate font-medium text-zinc-900">${escapeHtml(name)}</p>
                <p class="truncate text-xs text-zinc-500">${escapeHtml(user.nickNameWx || "-")}</p>
              </div>
            </div>
          </td>
          <td class="px-4 py-3 font-mono text-xs text-zinc-600" title="${escapeHtml(user.openId)}">${escapeHtml(maskOpenId(user.openId))}</td>
          <td class="px-4 py-3">${currentRoom}</td>
          <td class="px-4 py-3 text-zinc-600">${escapeHtml(formatTime(user.createdAt))}</td>
          <td class="px-4 py-3 text-zinc-600">${escapeHtml(formatTime(user.updatedAt))}</td>
          <td class="px-4 py-3 text-right">
            <div class="flex justify-end gap-2">
              <button class="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium hover:bg-zinc-50" data-action="edit" data-openid="${escapeHtml(user.openId)}" type="button">编辑</button>
              <button class="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50" data-action="delete" data-openid="${escapeHtml(user.openId)}" type="button">删除</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderPagination(total) {
  els.paginationInfo.textContent = `共 ${total} 个用户，第 ${state.page} / ${state.totalPages} 页`;
  els.prevPageButton.disabled = state.page <= 1 || state.loading;
  els.nextPageButton.disabled = state.page >= state.totalPages || state.loading;
}

async function loadUsers() {
  state.loading = true;
  renderUsers();
  renderPagination(0);

  try {
    const params = new URLSearchParams({
      q: state.q,
      page: String(state.page),
      pageSize: String(state.pageSize)
    });
    const data = await adminApi(`/users?${params.toString()}`);
    const pagination = data.pagination || {};
    state.users = Array.isArray(data.users) ? data.users : [];
    state.page = Number(pagination.page || state.page);
    state.total = Number(pagination.total || 0);
    state.totalPages = Number(pagination.totalPages || 1);
    showTableAlert("", "");
  } catch (err) {
    state.users = [];
    state.total = 0;
    showTableAlert(err.message || "加载失败", "error");
  } finally {
    state.loading = false;
    renderUsers();
    renderPagination(state.total);
  }
}

async function restoreSession() {
  try {
    const data = await adminApi("/session");
    state.csrfToken = data.csrfToken || "";
    setAuthenticated(true);
    await loadUsers();
  } catch (err) {
    setAuthenticated(false);
  }
}

function openUserModal(user) {
  const isEdit = !!user;
  state.editingOpenId = isEdit ? String(user.openId || "") : "";
  els.modalTitle.textContent = isEdit ? "编辑用户" : "新增用户";
  els.userOpenId.disabled = isEdit;
  els.userOpenId.value = isEdit ? user.openId || "" : "";
  els.userNickName.value = isEdit ? user.nickNameWx || "" : "";
  els.userDisplayName.value = isEdit ? user.displayName || "" : "";
  els.userAvatarUrl.value = isEdit ? user.avatarUrlWx || "" : "";
  showModalError("");
  els.userModal.classList.remove("hidden");
  els.userModal.classList.add("flex");
}

function closeUserModal() {
  els.userModal.classList.add("hidden");
  els.userModal.classList.remove("flex");
  state.editingOpenId = "";
}

async function handleLogin(event) {
  event.preventDefault();
  showLoginError("");
  setBusy(els.loginSubmit, true, "登录中...");

  try {
    const data = await adminApi("/login", {
      method: "POST",
      bodyJson: {
        username: els.loginUsername.value,
        password: els.loginPassword.value
      }
    });
    state.csrfToken = data.csrfToken || "";
    els.loginPassword.value = "";
    setAuthenticated(true);
    await loadUsers();
  } catch (err) {
    showLoginError(err.message || "登录失败");
  } finally {
    setBusy(els.loginSubmit, false, "登录");
  }
}

async function handleLogout() {
  setBusy(els.logoutButton, true, "退出中...");
  try {
    await adminApi("/logout", { method: "POST" });
  } catch (err) {
    // 退出失败时也清理本地状态，让用户回到登录入口。
  } finally {
    state.csrfToken = "";
    setAuthenticated(false);
    setBusy(els.logoutButton, false, "退出");
  }
}

async function handleUserSubmit(event) {
  event.preventDefault();
  showModalError("");
  setBusy(els.modalSubmitButton, true, "保存中...");

  const payload = {
    nickNameWx: els.userNickName.value,
    displayName: els.userDisplayName.value,
    avatarUrlWx: els.userAvatarUrl.value
  };
  if (!state.editingOpenId) {
    payload.openId = els.userOpenId.value;
  }

  try {
    const path = state.editingOpenId
      ? `/users/${encodeURIComponent(state.editingOpenId)}`
      : "/users";
    const method = state.editingOpenId ? "PUT" : "POST";
    await adminApi(path, { method, bodyJson: payload });
    closeUserModal();
    await loadUsers();
    showTableAlert("保存成功", "success");
  } catch (err) {
    showModalError(err.message || "保存失败");
  } finally {
    setBusy(els.modalSubmitButton, false, "保存");
  }
}

async function handleTableClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const openId = button.dataset.openid || "";
  if (button.dataset.action === "edit") {
    try {
      const data = await adminApi(`/users/${encodeURIComponent(openId)}`);
      openUserModal(data.user);
    } catch (err) {
      showTableAlert(err.message || "读取用户失败", "error");
    }
    return;
  }

  if (button.dataset.action === "delete") {
    const ok = window.confirm("确认删除该用户档案？房间和历史数据不会被级联删除。");
    if (!ok) return;

    try {
      await adminApi(`/users/${encodeURIComponent(openId)}`, { method: "DELETE" });
      await loadUsers();
      showTableAlert("删除成功", "success");
    } catch (err) {
      showTableAlert(err.message || "删除失败", "error");
    }
  }
}

function bindEvents() {
  els.loginForm.addEventListener("submit", handleLogin);
  els.logoutButton.addEventListener("click", handleLogout);
  els.refreshButton.addEventListener("click", () => loadUsers());
  els.createUserButton.addEventListener("click", () => openUserModal(null));
  els.modalCloseButton.addEventListener("click", closeUserModal);
  els.modalCancelButton.addEventListener("click", closeUserModal);
  els.userForm.addEventListener("submit", handleUserSubmit);
  els.usersBody.addEventListener("click", handleTableClick);

  els.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.q = els.searchInput.value.trim();
    state.page = 1;
    loadUsers();
  });

  els.prevPageButton.addEventListener("click", () => {
    if (state.page <= 1) return;
    state.page -= 1;
    loadUsers();
  });

  els.nextPageButton.addEventListener("click", () => {
    if (state.page >= state.totalPages) return;
    state.page += 1;
    loadUsers();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindElements();
  bindEvents();
  restoreSession();
});
