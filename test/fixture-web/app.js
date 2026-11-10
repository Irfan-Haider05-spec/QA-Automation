// Shared shell for the fixture dashboard: auth guard + nav
(function () {
  var token = localStorage.getItem("qa_token");
  if (!token && !location.pathname.endsWith("/login.html")) { location.href = "/web/login.html"; return; }
  window.api = function (path) {
    return fetch("/api/v1" + path, { headers: { authorization: "Bearer " + token } }).then(function (r) { return r.json(); });
  };
  document.addEventListener("DOMContentLoaded", function () {
    var nav = document.getElementById("nav");
    if (!nav) return;
    nav.innerHTML = [
      ["index.html", "Dashboard"], ["promotions.html", "Promotions"], ["reports.html", "Reports"],
      ["settings.html", "Settings"], ["insights.html", "Insights"], ["beta.html", "Beta"], ["logout.html", "Log out"]
    ].map(function (l) { return '<a href="/web/' + l[0] + '">' + l[1] + "</a>"; }).join(" · ");
  });
})();
