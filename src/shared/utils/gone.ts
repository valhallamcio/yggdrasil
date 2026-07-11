import type { Request, Response } from 'express';

/**
 * 410 Gone handler for endpoints removed in favour of the biforesting ops API (phase 9 —
 * Node never writes player .dat/stats files again; mutations run in-JVM on the backend).
 */
export function goneUseOpsApi(opHint: string): (req: Request, res: Response) => void {
  return (_req: Request, res: Response): void => {
    res.status(410).json({
      error: {
        code: 'GONE',
        message: `This write endpoint was removed — use the biforesting ops API instead (POST /v1/biforesting/:server/ops, op type: ${opHint}).`,
      },
    });
  };
}
