/** Worker→ControlCell wiring of group permissions on celld. */
export async function checkGroups(req, check, admin, alice) {
  const API = "/api/baskule";
  const A = { cookie: admin.cookie };
  const grant = await req("PATCH", `${API}/admin/groups/everyone`, { ...A, body: { permissions: { canCreateSpaces: true } } });
  check("Everyone group grants space creation", grant.status === 200 && grant.json.members.includes(alice.userId), grant.text);
  const me = await req("GET", `${API}/me`, { cookie: alice.cookie });
  check("me resolves space creation from groups", me.json.user.canCreateSpaces === true);
  check("Everyone cannot be deleted", (await req("DELETE", `${API}/admin/groups/everyone`, A)).status === 409);
  await req("PATCH", `${API}/admin/groups/everyone`, { ...A, body: { permissions: { canCreateSpaces: false } } });
}
