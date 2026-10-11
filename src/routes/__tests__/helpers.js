// Shared helpers for the route tests.
// Each test file runs in its own process and starts the real app on its own port.

export async function startApp(port) {
  process.env.PORT = String(port);
  await import('../../server.js');
  const base = `http://localhost:${port}`;

  // The server starts listening asynchronously, so wait until it answers
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base);
      return base;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Server did not start on port ${port}`);
}

// The app keeps its port open, so the test process must be closed explicitly
export function stopApp() {
  setTimeout(() => process.exit(0), 500);
}

// Register a brand new merchant (the seeded merchant@test.com cannot log in)
export async function registerMerchant(base) {
  const email = `qa-${Date.now()}-${Math.floor(Math.random() * 100000)}@test.com`;
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'SecurePass123!',
      business_name: 'QA Test Co'
    })
  });
  const data = await res.json();
  return { id: data.user.id, token: data.token, email };
}

export function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}