// Public Carpeta Tributaria task API the surfaces call (ADR-003).
//
// Carpeta Tributaria is SESSION-KEYED (ADR-005): it authorizes by the session principal,
// not by a represented empresa. The task rejects a representing operate pointer up front,
// before any session is opened, with an actionable "log in as the empresa" message.
//
// Fase 1: `regular` (Carpeta Tributaria Regular, flujo www2.sii.cl) e `instituciones`
// (lista viva de destinatarios válidos). Ver ADR-003.

import { withSession } from '../auth/index.js';
import { recordAudit } from '../audit/index.js';
import { readOperateState } from '../identity/index.js';
import { Rut } from '../rut/index.js';
import { ValidationError } from '../errors/index.js';
import {
  fetchCarpetaTributariaRegularPdf,
  fetchCarpetaTributariaInstitucionesList,
  type CarpetaTributariaRegularFormData,
  type Institucion,
} from '../portal/carpeta-tributaria-regular.js';
import type { AuditEntry, Runtime } from '../seams/index.js';

export type { CarpetaTributariaRegularFormData } from '../portal/carpeta-tributaria-regular.js';
export type { Institucion } from '../portal/carpeta-tributaria-regular.js';

const REGULAR_LABEL = 'Carpeta Tributaria Regular';

function audit(runtime: Runtime, action: string, result: string, extra: Partial<AuditEntry>): void {
  recordAudit(runtime, { action, result, ...extra });
}

/** Reject a representing operate pointer BEFORE opening a session (ADR-005). */
async function assertSelfOperating(runtime: Runtime): Promise<void> {
  const op = await readOperateState(runtime.store);
  if (op && op.operatingRut !== op.selfRut) {
    throw new ValidationError(
      `La Carpeta Tributaria es session-keyed: el SII autoriza por el titular de la sesion, ` +
        `no por el RUT operado (${Rut.parse(op.operatingRut).formatted}). Para la carpeta de ` +
        'esa empresa, inicia sesion como ella (`sii auth logout` y luego `sii auth login`).',
    );
  }
}

export interface CarpetaTributariaRegularArgs {
  readonly directorio: string;
  /** Datos del destinatario solicitados por el formulario de Carpeta Tributaria
   *  Regular. TODO: mapear a los nombres de parámetros reales del SII cuando se
   *  capture el payload desde DevTools. */
  readonly formData: CarpetaTributariaRegularFormData;
}

export interface CarpetaTributariaRegularResult {
  readonly rut: string;
  readonly tipoLabel: string;
  readonly path: string;
  readonly bytes: number;
  readonly codigo: number;
  readonly clave: string;
}

function base64ToUint8Array(base64: string): Uint8Array {
  // El barrel del core es Node-free (ADR-016): usamos atob en lugar de Buffer.
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Genera y descarga la Carpeta Tributaria Regular del SII.
 *  Usa el flujo www2.sii.cl confirmado el 2026-09-02. Reutiliza la sesión SSO
 *  existente (sin login nuevo) y guarda el PDF decodificado en disco.
 *  Session-keyed (ADR-005): el SII autoriza por el titular de la sesión. */
export async function carpetaTributariaRegularGenerar(
  runtime: Runtime,
  args: CarpetaTributariaRegularArgs,
): Promise<CarpetaTributariaRegularResult> {
  await assertSelfOperating(runtime);

  if (!runtime.files) {
    throw new Error('Runtime sin FileSink: no se pueden escribir documentos locales.');
  }

  const start = runtime.clock.now().getTime();
  try {
    const pdf = await withSession(runtime, async (session, ctx) =>
      fetchCarpetaTributariaRegularPdf(session, {
        rut: Rut.parse(ctx.sessionRut),
        formData: args.formData,
      }),
    );

    const bytes = base64ToUint8Array(pdf.base64);
    const name = `carpeta-tributaria-regular-${Date.now()}.pdf`;
    const path = await runtime.files.write(args.directorio, name, bytes);

    const res: CarpetaTributariaRegularResult = {
      rut: pdf.rut,
      tipoLabel: REGULAR_LABEL,
      path,
      bytes: bytes.length,
      codigo: pdf.codigo,
      clave: pdf.clave,
    };

    audit(runtime, 'carpeta_regular_generar', 'ok', {
      rut: res.rut,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return res;
  } catch (e) {
    audit(runtime, 'carpeta_regular_generar', 'failed', {});
    throw e;
  }
}

export interface CarpetaTributariaInstitucionesResult {
  readonly rut: string;
  readonly instituciones: readonly Institucion[];
}

/** Lista las instituciones destinatarias válidas para Carpeta Tributaria Regular
 *  directamente desde el SII (endpoint oficial). */
export async function carpetaTributariaInstituciones(
  runtime: Runtime,
): Promise<CarpetaTributariaInstitucionesResult> {
  await assertSelfOperating(runtime);
  const start = runtime.clock.now().getTime();
  try {
    const res = await withSession(runtime, async (session, ctx) => {
      const rut = Rut.parse(ctx.sessionRut);
      const list = await fetchCarpetaTributariaInstitucionesList(session, rut);
      return { rut: rut.formatted, instituciones: list };
    });
    audit(runtime, 'carpeta_instituciones', 'ok', {
      rut: res.rut,
      durationMs: runtime.clock.now().getTime() - start,
    });
    return res;
  } catch (e) {
    audit(runtime, 'carpeta_instituciones', 'failed', {});
    throw e;
  }
}
