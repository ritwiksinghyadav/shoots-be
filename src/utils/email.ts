import * as dotenv from 'dotenv';
import { Brevo, BrevoClient, BrevoError } from '@getbrevo/brevo';

dotenv.config();

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'ritwikfullstack@gmail.com';
const SENDER_NAME = process.env.SENDER_NAME || 'SHOOTS';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3005';

function formatDisplayDate(dateStr: string): string {
  try {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const monthIdx = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      const dateObj = new Date(year, monthIdx, day);
      return dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  } catch (e) {
    // Fall back to raw string
  }
  return dateStr;
}

export async function sendInvitationEmail(
  toEmail: string,
  ownerName: string,
  projectName: string,
  clientName: string,
  shootDates: string[]
): Promise<boolean> {
  if (!BREVO_API_KEY) {
    console.warn('sendInvitationEmail: BREVO_API_KEY is not defined. Skipping email sending.');
    return false;
  }

  // Format the shoot dates nicely
  const sortedDates = [...shootDates].sort();
  const formattedDates = sortedDates.length > 0
    ? sortedDates.map(d => formatDisplayDate(d)).join(', ')
    : 'TBD';

  const client = new BrevoClient({ apiKey: BREVO_API_KEY });

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Added to project</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background-color: #FAFAF8;
          color: #1C1917;
          padding: 40px 20px;
          margin: 0;
        }
        .container {
          max-width: 500px;
          margin: 0 auto;
          background-color: #FFFFFF;
          border: 1px solid #E7E5E4;
          border-radius: 20px;
          padding: 36px;
          box-shadow: 0 4px 12px rgba(28, 25, 23, 0.03);
        }
        .logo {
          font-weight: 800;
          font-size: 16px;
          letter-spacing: -0.025em;
          margin-bottom: 28px;
          color: #1C1917;
        }
        h1 {
          font-size: 22px;
          font-weight: 700;
          letter-spacing: -0.02em;
          margin-top: 0;
          margin-bottom: 16px;
          color: #1C1917;
        }
        p {
          font-size: 14px;
          line-height: 1.6;
          color: #44403C;
          margin-top: 0;
          margin-bottom: 24px;
        }
        .details-card {
          background-color: #F7F6F3;
          border: 1px solid #E7E5E4;
          border-radius: 12px;
          padding: 16px 20px;
          margin-bottom: 28px;
        }
        .details-row {
          display: flex;
          padding: 8px 0;
          border-bottom: 1px solid #E7E5E4;
          font-size: 13px;
        }
        .details-row:last-child {
          border-bottom: none;
        }
        .details-label {
          font-weight: 600;
          color: #78716C;
          width: 100px;
          flex-shrink: 0;
        }
        .details-value {
          color: #1C1917;
          font-weight: 500;
        }
        .btn-container {
          text-align: center;
          margin-top: 28px;
          margin-bottom: 12px;
        }
        .btn {
          display: inline-block;
          background-color: #1C1917;
          color: #FFFFFF !important;
          text-decoration: none;
          padding: 12px 28px;
          border-radius: 9999px;
          font-size: 13px;
          font-weight: 600;
          text-align: center;
          transition: background-color 150ms ease;
        }
        .footer-note {
          font-size: 12px;
          color: #A8A29E;
          text-align: center;
          margin-top: 32px;
          line-height: 1.5;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">📷 SHOOTS</div>
        <h1>New Project Assignment</h1>
        <p>Hi there,</p>
        <p>You have been added to a photography project by <strong>${ownerName}</strong>. Here are the details of the project:</p>
        
        <div class="details-card">
          <div class="details-row">
            <span class="details-label">Project</span>
            <span class="details-value">${projectName}</span>
          </div>
          <div class="details-row">
            <span class="details-label">Client</span>
            <span class="details-value">${clientName}</span>
          </div>
          <div class="details-row">
            <span class="details-label">Date(s)</span>
            <span class="details-value">${formattedDates}</span>
          </div>
        </div>

        <p>We welcome you to continue browsing your projects, tracking schedules, and payments on SHOOTS.</p>
        
        <div class="btn-container">
          <a href="${FRONTEND_URL}/login" class="btn">Access Project</a>
        </div>
        
        <div class="footer-note">
          This invitation was sent from SHOOTS because your email was added to a project crew.
        </div>
      </div>
    </body>
    </html>
  `;

  const emailData: Brevo.SendTransacEmailRequest = {
    subject: `You've been added to "${projectName}" on SHOOTS`,
    htmlContent,
    to: [{ email: toEmail }],
    sender: {
      name: SENDER_NAME,
      email: SENDER_EMAIL
    }
  };

  try {
    const res = await client.transactionalEmails.sendTransacEmail(emailData);
    console.log(`Successfully sent invitation email to ${toEmail} via Brevo SDK. Response:`, res);
    return true;
  } catch (error) {
    if (error instanceof Brevo.UnauthorizedError) {
      console.error('Brevo API Error: Invalid API key or IP address restriction (UnauthorizedError)');
    } else if (error instanceof Brevo.TooManyRequestsError) {
      console.error('Brevo API Error: Rate limited (TooManyRequestsError)');
    } else if (error instanceof BrevoError) {
      console.error(`Brevo API Error ${error.statusCode}:`, error.message);
    } else {
      console.error(`Error sending invitation email to ${toEmail} via Brevo SDK:`, error);
    }
    return false;
  }
}

export async function sendPasswordResetEmail(
  toEmail: string,
  resetLink: string
): Promise<boolean> {
  if (!BREVO_API_KEY) {
    console.warn('sendPasswordResetEmail: BREVO_API_KEY is not defined. Skipping email sending.');
    return false;
  }

  const client = new BrevoClient({ apiKey: BREVO_API_KEY });

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Reset your password</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background-color: #FAFAF8;
          color: #1C1917;
          padding: 40px 20px;
          margin: 0;
        }
        .container {
          max-width: 500px;
          margin: 0 auto;
          background-color: #FFFFFF;
          border: 1px solid #E7E5E4;
          border-radius: 20px;
          padding: 36px;
          box-shadow: 0 4px 12px rgba(28, 25, 23, 0.03);
        }
        .logo {
          font-weight: 800;
          font-size: 16px;
          letter-spacing: -0.025em;
          margin-bottom: 28px;
          color: #1C1917;
        }
        h1 {
          font-size: 22px;
          font-weight: 700;
          letter-spacing: -0.02em;
          margin-top: 0;
          margin-bottom: 16px;
          color: #1C1917;
        }
        p {
          font-size: 14px;
          line-height: 1.6;
          color: #44403C;
          margin-top: 0;
          margin-bottom: 24px;
        }
        .btn-container {
          text-align: center;
          margin-top: 28px;
          margin-bottom: 12px;
        }
        .btn {
          display: inline-block;
          background-color: #1C1917;
          color: #FFFFFF !important;
          text-decoration: none;
          padding: 12px 28px;
          border-radius: 9999px;
          font-size: 13px;
          font-weight: 600;
          text-align: center;
          transition: background-color 150ms ease;
        }
        .footer-note {
          font-size: 12px;
          color: #A8A29E;
          text-align: center;
          margin-top: 32px;
          line-height: 1.5;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">📷 SHOOTS</div>
        <h1>Reset your password</h1>
        <p>Hi there,</p>
        <p>We received a request to reset your password for your SHOOTS account. Click the button below to choose a new password. This link is valid for 1 hour.</p>
        
        <div class="btn-container">
          <a href="${resetLink}" class="btn">Reset Password</a>
        </div>
        
        <p style="font-size: 12px; color: #78716C; margin-top: 20px; word-break: break-all;">
          If the button doesn't work, copy and paste this URL into your browser: <br/>
          <a href="${resetLink}" style="color: #1C1917; text-decoration: underline;">${resetLink}</a>
        </p>

        <div class="footer-note">
          If you did not request this, you can safely ignore this email. Your password will remain unchanged.
        </div>
      </div>
    </body>
    </html>
  `;

  const emailData: Brevo.SendTransacEmailRequest = {
    subject: 'Reset your password on SHOOTS',
    htmlContent,
    to: [{ email: toEmail }],
    sender: {
      name: SENDER_NAME,
      email: SENDER_EMAIL
    }
  };

  try {
    const res = await client.transactionalEmails.sendTransacEmail(emailData);
    console.log(`Successfully sent password reset email to ${toEmail} via Brevo SDK. Response:`, res);
    return true;
  } catch (error) {
    if (error instanceof Brevo.UnauthorizedError) {
      console.error('Brevo API Error: Invalid API key or IP address restriction (UnauthorizedError)');
    } else if (error instanceof Brevo.TooManyRequestsError) {
      console.error('Brevo API Error: Rate limited (TooManyRequestsError)');
    } else if (error instanceof BrevoError) {
      console.error(`Brevo API Error ${error.statusCode}:`, error.message);
    } else {
      console.error(`Error sending password reset email to ${toEmail} via Brevo SDK:`, error);
    }
    return false;
  }
}
