/** Thin API client for the RAT backend. */

async function request(path, options = {}) {
  const res = await fetch(path, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    throw new Error((body && body.error) || `Request failed (${res.status})`);
  }
  return body;
}

export const api = {
  listRepos: () => request('/api/repos'),
  getRepo: (id) => request(`/api/repos/${id}`),
  deleteRepo: (id) => request(`/api/repos/${id}`, { method: 'DELETE' }),
  uploadRepo: (file, name) => {
    const form = new FormData();
    form.append('file', file);
    if (name) form.append('name', name);
    return request('/api/repos/upload', { method: 'POST', body: form });
  },
  cloneRepo: (url, name) =>
    request('/api/repos/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, name }),
    }),
  listAuthors: (id) => request(`/api/repos/${id}/authors`),
  mergeAuthors: (id, emails, canonical) =>
    request(`/api/repos/${id}/authors/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails, canonical }),
    }),
  unmergeAuthors: (id, email) =>
    request(`/api/repos/${id}/authors/unmerge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }),
  suggestPaths: (id, q, limit = 25) =>
    request(`/api/repos/${id}/paths?q=${encodeURIComponent(q)}&limit=${limit}`),
  listCommits: (id, params) =>
    request(`/api/repos/${id}/commits?${new URLSearchParams(params)}`),
  getMetrics: (id, params) => request(`/api/repos/${id}/metrics?${new URLSearchParams(params)}`),
};
