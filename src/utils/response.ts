import { Response } from 'express';

export function sendSuccess(
  res: Response,
  statusCode: number,
  result: any,
  message: string = 'Success'
) {
  return res.status(statusCode).json({
    success: true,
    result,
    message,
    statusCode,
  });
}

export interface ErrorPayload {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export function sendError(
  res: Response,
  statusCode: number,
  errorPayload: ErrorPayload
) {
  return res.status(statusCode).json({
    success: false,
    error: errorPayload,
    statusCode,
  });
}
