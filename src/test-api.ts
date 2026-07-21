import { sql } from 'drizzle-orm';
import { db } from './db/index.js';

const API_BASE = 'http://localhost:5000/api/v1';

async function cleanupDb() {
  console.log('Cleaning up test users from database...');
  try {
    // Delete test users (cascading will delete projects, shoot days, members, expenses)
    await db.execute(sql`DELETE FROM users WHERE email IN ('test_owner@example.com', 'test_member@example.com')`);
    console.log('Database cleanup done.');
  } catch (err) {
    console.error('Cleanup failed:', err);
  }
}

async function runTests() {
  await cleanupDb();

  console.log('\n=== Starting Integration Tests ===\n');

  let ownerToken = '';
  let memberToken = '';
  let ownerId = '';
  let memberId = '';
  let projectId = '';
  let shootDayId = '';
  let shootMemberId = '';
  let expenseId = '';

  // 1. Auth - Register Owner
  console.log('1. Testing /auth/register (Owner)...');
  const regOwnerRes = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test Owner',
      email: 'test_owner@example.com',
      password: 'password123',
      businessName: 'Owner Studio'
    })
  });
  const regOwnerJson = await regOwnerRes.json() as any;
  if (regOwnerRes.status !== 201 || !regOwnerJson.success) {
    console.error('FAIL: Owner registration failed', regOwnerRes.status, regOwnerJson);
    return;
  }
  console.log('PASS: Owner registered successfully');
  ownerId = regOwnerJson.result.user.id;

  // 2. Auth - Register Member
  console.log('2. Testing /auth/register (Member)...');
  const regMemberRes = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test Member',
      email: 'test_member@example.com',
      password: 'password123',
      businessName: 'Member Studio'
    })
  });
  const regMemberJson = await regMemberRes.json() as any;
  if (regMemberRes.status !== 201 || !regMemberJson.success) {
    console.error('FAIL: Member registration failed', regMemberRes.status, regMemberJson);
    return;
  }
  console.log('PASS: Member registered successfully');
  memberId = regMemberJson.result.user.id;

  // 3. Auth - Login Owner
  console.log('3. Testing /auth/login (Owner)...');
  const loginOwnerRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'test_owner@example.com',
      password: 'password123'
    })
  });
  const loginOwnerJson = await loginOwnerRes.json() as any;
  if (loginOwnerRes.status !== 200 || !loginOwnerJson.success) {
    console.error('FAIL: Owner login failed', loginOwnerRes.status, loginOwnerJson);
    return;
  }
  ownerToken = loginOwnerJson.result.accessToken;
  console.log('PASS: Owner logged in successfully');

  // 4. Auth - Login Member
  console.log('4. Testing /auth/login (Member)...');
  const loginMemberRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'test_member@example.com',
      password: 'password123'
    })
  });
  const loginMemberJson = await loginMemberRes.json() as any;
  if (loginMemberRes.status !== 200 || !loginMemberJson.success) {
    console.error('FAIL: Member login failed', loginMemberRes.status, loginMemberJson);
    return;
  }
  memberToken = loginMemberJson.result.accessToken;
  console.log('PASS: Member logged in successfully');

  // 5. Auth - Profile /auth/me (GET)
  console.log('5. Testing /auth/me (GET)...');
  const meRes = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const meJson = await meRes.json() as any;
  if (meRes.status !== 200 || !meJson.success || meJson.result.user.email !== 'test_owner@example.com') {
    console.error('FAIL: Fetch profile failed', meRes.status, meJson);
  } else {
    console.log('PASS: Profile fetched successfully');
  }

  // 6. Auth - Profile /auth/me (PUT)
  console.log('6. Testing /auth/me (PUT)...');
  const updateMeRes = await fetch(`${API_BASE}/auth/me`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`
    },
    body: JSON.stringify({
      name: 'Updated Owner Name',
      preferredCurrency: 'INR'
    })
  });
  const updateMeJson = await updateMeRes.json() as any;
  if (updateMeRes.status !== 200 || !updateMeJson.success || updateMeJson.result.user.name !== 'Updated Owner Name') {
    console.error('FAIL: Update profile failed', updateMeRes.status, updateMeJson);
  } else {
    console.log('PASS: Profile updated successfully');
  }

  // 7. Projects - Create Project (POST /projects)
  console.log('7. Testing POST /projects...');
  const createProjRes = await fetch(`${API_BASE}/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`
    },
    body: JSON.stringify({
      title: 'Summer Collection',
      client: 'Vogue India',
      status: 'booked',
      budget: 150000,
      icon: '📸',
      notes: 'Shoot for summer wear',
      shootDays: [
        {
          date: '2026-08-10',
          time: '09:00',
          locationName: 'Studio 44',
          notes: 'Main shoot'
        }
      ]
    })
  });
  const createProjJson = await createProjRes.json() as any;
  if (createProjRes.status !== 201 || !createProjJson.success) {
    console.error('FAIL: Project creation failed', createProjRes.status, createProjJson);
    return;
  }
  projectId = createProjJson.result.project.id;
  shootDayId = createProjJson.result.project.shootDays[0].id;
  console.log('PASS: Project created successfully, ID:', projectId);

  // 8. Projects - List Projects (GET /projects)
  console.log('8. Testing GET /projects...');
  const listProjRes = await fetch(`${API_BASE}/projects`, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const listProjJson = await listProjRes.json() as any;
  if (listProjRes.status !== 200 || !listProjJson.success || listProjJson.result.projects.length === 0) {
    console.error('FAIL: Listing projects failed', listProjRes.status, listProjJson);
  } else {
    console.log('PASS: Listing projects successful, found:', listProjJson.result.projects.length);
  }

  // 9. Projects - Get Project by ID (GET /projects/:id)
  console.log('9. Testing GET /projects/:id...');
  const getProjRes = await fetch(`${API_BASE}/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const getProjJson = await getProjRes.json() as any;
  if (getProjRes.status !== 200 || !getProjJson.success || getProjJson.result.project.id !== projectId) {
    console.error('FAIL: Get project failed', getProjRes.status, getProjJson);
  } else {
    console.log('PASS: Get project successful');
  }

  // 10. Projects - Update Project (PUT /projects/:id)
  console.log('10. Testing PUT /projects/:id...');
  const updateProjRes = await fetch(`${API_BASE}/projects/${projectId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`
    },
    body: JSON.stringify({
      title: 'Summer Collection 2026',
      budget: 180000
    })
  });
  const updateProjJson = await updateProjRes.json() as any;
  if (updateProjRes.status !== 200 || !updateProjJson.success || updateProjJson.result.project.budget !== 180000) {
    console.error('FAIL: Update project failed', updateProjRes.status, updateProjJson);
  } else {
    console.log('PASS: Update project successful');
  }

  // 11. Shoot Days - Add Shoot Day (POST /projects/:projectId/days)
  console.log('11. Testing POST /projects/:projectId/days...');
  const addDayRes = await fetch(`${API_BASE}/projects/${projectId}/days`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`
    },
    body: JSON.stringify({
      date: '2026-08-11',
      time: '10:00',
      locationName: 'Goa Beach',
      notes: 'Outdoor shots'
    })
  });
  const addDayJson = await addDayRes.json() as any;
  let newDayId = '';
  if ((addDayRes.status !== 200 && addDayRes.status !== 201) || !addDayJson.success) {
    console.error('FAIL: Add shoot day failed', addDayRes.status, addDayJson);
  } else {
    newDayId = addDayJson.result.shootDay.id;
    console.log('PASS: Add shoot day successful, Day ID:', newDayId);
  }

  // 12. Shoot Days - Update Shoot Day (PUT /projects/:projectId/days/:dayId)
  console.log('12. Testing PUT /projects/:projectId/days/:dayId...');
  const updateDayRes = await fetch(`${API_BASE}/projects/${projectId}/days/${shootDayId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`
    },
    body: JSON.stringify({
      time: '08:30',
      locationName: 'Studio 44 - Main Room',
      notes: 'Main shoot updated'
    })
  });
  const updateDayJson = await updateDayRes.json() as any;
  if (updateDayRes.status !== 200 || !updateDayJson.success) {
    console.error('FAIL: Update shoot day failed', updateDayRes.status, updateDayJson);
  } else {
    console.log('PASS: Update shoot day successful');
  }

  // 13. Team Members - Add Team Member (POST /projects/:projectId/members)
  console.log('13. Testing POST /projects/:projectId/members...');
  const addMemberRes = await fetch(`${API_BASE}/projects/${projectId}/members`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`
    },
    body: JSON.stringify({
      email: 'test_member@example.com',
      payment: 50000,
      paymentStatus: 'unpaid',
      invited: true
    })
  });
  const addMemberJson = await addMemberRes.json() as any;
  if (addMemberRes.status !== 201 || !addMemberJson.success) {
    console.error('FAIL: Add team member failed', addMemberRes.status, addMemberJson);
  } else {
    shootMemberId = addMemberJson.result.members[0].id;
    console.log('PASS: Add team member successful, Member ID:', shootMemberId);
  }

  // 14. Team Members - Update Team Member (PUT /projects/:projectId/members/:memberId)
  console.log('14. Testing PUT /projects/:projectId/members/:memberId...');
  const updateMemberRes = await fetch(`${API_BASE}/projects/${projectId}/members/${shootMemberId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`
    },
    body: JSON.stringify({
      payment: 55000,
      paymentStatus: 'paid'
    })
  });
  const updateMemberJson = await updateMemberRes.json() as any;
  if (updateMemberRes.status !== 200 || !updateMemberJson.success || updateMemberJson.result.member.payment !== 55000) {
    console.error('FAIL: Update team member failed', updateMemberRes.status, updateMemberJson);
  } else {
    console.log('PASS: Update team member successful');
  }

  // 15. Expenses - Add Expense (POST /projects/:projectId/expenses)
  console.log('15. Testing POST /projects/:projectId/expenses...');
  const addExpRes = await fetch(`${API_BASE}/projects/${projectId}/expenses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`
    },
    body: JSON.stringify({
      label: 'Camera rental',
      amount: 12000,
      category: 'equipment',
      date: '2026-08-10'
    })
  });
  const addExpJson = await addExpRes.json() as any;
  if (addExpRes.status !== 200 && addExpRes.status !== 201) {
    console.error('FAIL: Add expense failed', addExpRes.status, addExpJson);
  } else {
    expenseId = addExpJson.result.expense.id;
    console.log('PASS: Add expense successful, Expense ID:', expenseId);
  }

  // 16. Expenses - List Expenses (GET /projects/:projectId/expenses)
  console.log('16. Testing GET /projects/:projectId/expenses...');
  const listExpRes = await fetch(`${API_BASE}/projects/${projectId}/expenses`, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const listExpJson = await listExpRes.json() as any;
  if (listExpRes.status !== 200 || !listExpJson.success || listExpJson.result.expenses.length === 0) {
    console.error('FAIL: Listing expenses failed', listExpRes.status, listExpJson);
  } else {
    console.log('PASS: Listing expenses successful, found:', listExpJson.result.expenses.length);
  }

  // 17. Projects - Upcoming Days (GET /projects/upcoming-days)
  console.log('17. Testing GET /projects/upcoming-days...');
  const upcomingRes = await fetch(`${API_BASE}/projects/upcoming-days`, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const upcomingJson = await upcomingRes.json() as any;
  if (upcomingRes.status !== 200 || !upcomingJson.success) {
    console.error('FAIL: Fetch upcoming shoot days failed', upcomingRes.status, upcomingJson);
  } else {
    console.log('PASS: Fetch upcoming shoot days successful, count:', upcomingJson.result.shootDays?.length ?? upcomingJson.result.length);
  }

  // 18. Projects - Shoot Days / Calendar (GET /projects/shoot-days)
  console.log('18. Testing GET /projects/shoot-days...');
  const shootDaysRes = await fetch(`${API_BASE}/projects/shoot-days?year=2026&month=8`, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const shootDaysJson = await shootDaysRes.json() as any;
  if (shootDaysRes.status !== 200 || !shootDaysJson.success) {
    console.error('FAIL: Fetch shoot days (calendar) failed', shootDaysRes.status, shootDaysJson);
  } else {
    console.log('PASS: Fetch shoot days successful, count:', shootDaysJson.result.shootDays?.length ?? shootDaysJson.result.length);
  }

  // 19. Projects - Analytics (GET /projects/analytics)
  console.log('19. Testing GET /projects/analytics...');
  const analyticsRes = await fetch(`${API_BASE}/projects/analytics`, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const analyticsJson = await analyticsRes.json() as any;
  if (analyticsRes.status !== 200 || !analyticsJson.success) {
    console.error('FAIL: Fetch analytics failed', analyticsRes.status, analyticsJson);
  } else {
    console.log('PASS: Fetch analytics successful');
  }

  // 20. Projects - Earnings History (GET /projects/earnings-history)
  console.log('20. Testing GET /projects/earnings-history...');
  const earningsRes = await fetch(`${API_BASE}/projects/earnings-history`, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const earningsJson = await earningsRes.json() as any;
  if (earningsRes.status !== 200 || !earningsJson.success) {
    console.error('FAIL: Fetch earnings history failed', earningsRes.status, earningsJson);
  } else {
    console.log('PASS: Fetch earnings history successful');
  }

  // 21. Team Directory - GET /team-members
  console.log('21. Testing GET /team-members...');
  const teamRes = await fetch(`${API_BASE}/team-members`, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const teamJson = await teamRes.json() as any;
  if (teamRes.status !== 200 || !teamJson.success) {
    console.error('FAIL: Fetch team directory failed', teamRes.status, teamJson);
  } else {
    console.log('PASS: Fetch team directory successful, count:', teamJson.result.teamMembers?.length);
  }

  // 22. Access Control - Member Access to Project details (GET /projects/:id as member)
  console.log('22. Testing GET /projects/:id as Member (Should have restricted access)...');
  const getProjAsMemberRes = await fetch(`${API_BASE}/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${memberToken}` }
  });
  const getProjAsMemberJson = await getProjAsMemberRes.json() as any;
  if (getProjAsMemberRes.status !== 200 || !getProjAsMemberJson.success) {
    console.error('FAIL: Member could not retrieve project they are part of', getProjAsMemberRes.status, getProjAsMemberJson);
  } else {
    const proj = getProjAsMemberJson.result.project;
    console.log('PASS: Member retrieved project. Owner:', proj.ownerName, 'Title:', proj.title);
    
    // Check field stripping assertions
    let strippingFailed = false;
    if (proj.budget !== 0) {
      console.error('FAIL: Member budget was not stripped (value:', proj.budget, ')');
      strippingFailed = true;
    }
    if (proj.expenses.length !== 0) {
      console.error('FAIL: Member expenses list was not stripped (length:', proj.expenses.length, ')');
      strippingFailed = true;
    }
    
    if (proj.team && proj.team.length > 0) {
      for (const t of proj.team) {
        // Owner is virtually added with id `owner-...` and payment 0, which is fine.
        // For other members, check that they are stripped unless it is the test_member himself
        const isSelf = t.email.toLowerCase() === 'test_member@example.com';
        const isOwnerVirtual = t.id.startsWith('owner-');
        if (!isSelf && !isOwnerVirtual) {
          if (t.payment !== 0 || t.paymentStatus !== 'unpaid') {
            console.error(`FAIL: Payment info of another member (${t.name || t.email}) was leaked: payment=${t.payment}, status=${t.paymentStatus}`);
            strippingFailed = true;
          }
        }
      }
    }
    
    if (!strippingFailed) {
      console.log('PASS: All member field stripping rules enforced (budget=0, expenses=[], other payments masked)');
    }
  }

  // 23. Access Control - Unauthorized Access (should be blocked)
  console.log('23. Testing POST /projects/:projectId/expenses as Member (Should be forbidden)...');
  const addExpAsMemberRes = await fetch(`${API_BASE}/projects/${projectId}/expenses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${memberToken}`
    },
    body: JSON.stringify({
      label: 'Attempted MUA expense',
      amount: 5000,
      category: 'misc'
    })
  });
  const addExpAsMemberJson = await addExpAsMemberRes.json() as any;
  if (addExpAsMemberRes.status === 403) {
    console.log('PASS: Member forbidden from adding expense (Status: 403 Forbidden)');
  } else {
    console.error('FAIL: Member mutation did not return 403 Forbidden. Status:', addExpAsMemberRes.status, addExpAsMemberJson);
  }

  // 24. Shoot Days - Delete Shoot Day (DELETE /projects/:projectId/days/:dayId)
  if (newDayId) {
    console.log('24. Testing DELETE /projects/:projectId/days/:dayId...');
    const deleteDayRes = await fetch(`${API_BASE}/projects/${projectId}/days/${newDayId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const deleteDayJson = await deleteDayRes.json() as any;
    if (deleteDayRes.status !== 200 || !deleteDayJson.success) {
      console.error('FAIL: Delete shoot day failed', deleteDayRes.status, deleteDayJson);
    } else {
      console.log('PASS: Delete shoot day successful');
    }
  }

  // 25. Expenses - Delete Expense (DELETE /projects/:projectId/expenses/:expenseId)
  if (expenseId) {
    console.log('25. Testing DELETE /projects/:projectId/expenses/:expenseId...');
    const deleteExpRes = await fetch(`${API_BASE}/projects/${projectId}/expenses/${expenseId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const deleteExpJson = await deleteExpRes.json() as any;
    if (deleteExpRes.status !== 200 || !deleteExpJson.success) {
      console.error('FAIL: Delete expense failed', deleteExpRes.status, deleteExpJson);
    } else {
      console.log('PASS: Delete expense successful');
    }
  }

  // 26. Projects - Delete Project (DELETE /projects/:id)
  console.log('26. Testing DELETE /projects/:id...');
  const deleteProjRes = await fetch(`${API_BASE}/projects/${projectId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const deleteProjJson = await deleteProjRes.json() as any;
  if (deleteProjRes.status !== 200 || !deleteProjJson.success) {
    console.error('FAIL: Delete project failed', deleteProjRes.status, deleteProjJson);
  } else {
    console.log('PASS: Delete project successful');
  }

  console.log('\n=== E2E Integration Tests Finished ===\n');
  await cleanupDb();
}

runTests().catch(console.error);
