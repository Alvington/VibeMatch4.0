// Shared helpers for the VibeMatch app pages (profile/discover/chat).
// Plain JS, no build step - loaded via <script src="app.js"> after app.css.

const $ = (id) => document.getElementById(id);

function getUserId() {
  const raw = localStorage.getItem("vm_userId");
  return raw ? Number(raw) : null;
}

function setUserId(id) {
  localStorage.setItem("vm_userId", String(id));
}

function requireAuth() {
  const id = getUserId();
  if (!id) {
    window.location.href = "login.html";
    return null;
  }
  return id;
}

function logout() {
  localStorage.removeItem("vm_userId");
  window.location.href = "index.html";
}

/** Injects the logged-in app nav into <div id="appNav"></div>. */
function renderAppNav(activePage) {
  const el = $("appNav");
  if (!el) return;
  const userId = getUserId();
  const link = (href, label, key) =>
    `<a href="${href}" class="${activePage === key ? "active" : ""}">${label}</a>`;

  el.innerHTML = `
    <div class="nav-mark"><span class="dot"></span>VibeMatch</div>
    <div class="app-links">
      ${link("profile.html", "Profile", "profile")}
      ${link("discover.html", "Discover", "discover")}
      ${link("chat.html", "Chat", "chat")}
    </div>
    <div class="app-right">
      <span class="user-chip" id="navUserChip">…</span>
      <a href="#" class="logout-link" id="logoutLink">Log out</a>
    </div>
  `;
  $("logoutLink").addEventListener("click", (e) => {
    e.preventDefault();
    logout();
  });

  // Fetched fresh each load (rather than cached) so an updated name shows up
  // immediately on every page, including right after a profile edit.
  if (userId) {
    fetch(`/api/profile/${userId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((user) => {
        const chip = $("navUserChip");
        if (!chip) return; // page may have navigated away already
        chip.textContent = user?.name?.trim() ? user.name : `user #${userId}`;
      })
      .catch(() => {
        const chip = $("navUserChip");
        if (chip) chip.textContent = `user #${userId}`;
      });
  }
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status-line" + (kind ? " " + kind : "");
}