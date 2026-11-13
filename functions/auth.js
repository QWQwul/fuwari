export async function onRequestGet({ request, env }) {
	const url = new URL(request.url);
	const params = new URLSearchParams({
		client_id: env.GITHUB_CLIENT_ID,
		redirect_uri: `${url.origin}/callback`,
		scope: "repo,user",
		state: crypto.randomUUID(),
	});
	return Response.redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
}
