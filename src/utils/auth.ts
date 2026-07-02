import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const BCRYPT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export interface JWTPayload {
  userId: string;
  email: string;
}

export function generateAccessToken(payload: JWTPayload): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET is not configured');
  return jwt.sign(payload, secret, { expiresIn: '15m' });
}

export function generateRefreshToken(payload: JWTPayload): string {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) throw new Error('JWT_REFRESH_SECRET is not configured');
  return jwt.sign(payload, secret, { expiresIn: '30d' });
}

export function verifyAccessToken(token: string): JWTPayload {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET is not configured');
  return jwt.verify(token, secret) as JWTPayload;
}

export function verifyRefreshToken(token: string): JWTPayload {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) throw new Error('JWT_REFRESH_SECRET is not configured');
  return jwt.verify(token, secret) as JWTPayload;
}


