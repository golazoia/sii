// Carpeta Tributaria Regular — www2.sii.cl / cte-api-carpetatributaria flow.
//
// Observed at https://www2.sii.cl/carpetatributaria/generarcteregular on 2026-09-02:
// 1. The authenticated browser loads
//    `https://www2.sii.cl/carpetatributaria/generarcteregular`.
// 2. Pressing "Continuar" sends:
//      POST /app/cte-api-carpetatributaria/{rut}/recurso/v2/carpeta-tributaria/generar
//    with JSON payload (RUT/email synthetic here — real values are per-request):
//      {
//        "carpRutReceptor": "11111111",
//        "carpDvReceptor": "1",
//        "carpMailReceptor": "receptor@example.com",
//        "carpTipo": 1,
//        "enfinCodigo": "059",
//        "carpNombreOtraInstitucion": ""
//      }
//    Response:
//      { "carpCodigoRepositorio": 33232702, "carpClaveCarpeta": "2J12MxkF3O" }
// 3. Immediately followed by:
//      GET /app/cte-api-carpetatributaria/{rut}/recurso/v2/carpeta-tributaria/pdfInicial/{carpCodigoRepositorio}
//    with Referer = the generación page. SII responds `{ "base64": "JVBERi0xLjQK..." }`
//    (PDF encoded as base64).
//
// Note (#111 / PR #112): `obtenerValorParametro` is NOT the PDF endpoint. On a LIVE
// session it responds 200 text/plain with the URL of the "cambiar email/teléfono"
// widget. The SPA calls it only to know that widget's URL. Do NOT use it here.

import { z } from 'zod';
import { HOSTS } from '../config/index.js';
import { CarpetaTributariaError } from '../errors/index.js';
import { Rut } from '../rut/index.js';
import type { PortalSession } from '../seams/index.js';

const GENERAR_PAGE = `${HOSTS.www2}/carpetatributaria/generarcteregular`;

function apiBaseUrl(rut: Rut): string {
  return `${HOSTS.www2}/app/cte-api-carpetatributaria/${rut.canonical}`;
}

function generarUrl(rut: Rut): string {
  return `${apiBaseUrl(rut)}/recurso/v2/carpeta-tributaria/generar`;
}

function pdfInicialUrl(rut: Rut, codigoRepositorio: number): string {
  return `${apiBaseUrl(rut)}/recurso/v2/carpeta-tributaria/pdfInicial/${codigoRepositorio}`;
}

function institucionesUrl(rut: Rut): string {
  return `${apiBaseUrl(rut)}/recurso/v2/carpeta-tributaria/instituciones`;
}

function sessionStatusUrl(originalUrl: string): string {
  return `${HOSTS.www2}/app/session/status?originalUrl=${encodeURIComponent(originalUrl)}`;
}

function isValidBase64Pdf(base64: string): boolean {
  if (!base64 || typeof base64 !== 'string') return false;
  // A base64-encoded PDF starts with the "JVBERi" magic.
  return base64.startsWith('JVBERi');
}

/** Datos que solicita el formulario de Carpeta Tributaria Regular. Los nombres
 *  son internos; el portal los mapea a los campos exactos que exige el SII. */
export interface CarpetaTributariaRegularFormData {
  readonly rutDestinatario: string;
  readonly nombreDestinatario: string;
  readonly emailDestinatario: string;
  readonly confirmarEmailDestinatario: string;
  readonly institucionDestinataria: string;
  readonly otraInstitucion?: string;
  readonly autorizaDestinatario: boolean;
}

export interface CarpetaTributariaRegularPdf {
  readonly rut: string;
  readonly contentType: string;
  readonly base64: string;
  readonly codigo: number;
  readonly clave: string;
}

function parseRutReceptor(rutDestinatario: string): { body: string; dv: string } {
  const parsed = Rut.parse(rutDestinatario);
  return { body: String(parsed.body), dv: parsed.dv };
}

/** Institución destinataria válida, en la forma curada del repo. */
export interface Institucion {
  readonly codigo: string;
  readonly descripcion: string;
  readonly abreviacion: string;
}

// --- Wire envelope (zod-at-the-boundary, ADR-011) --------------------------------
// The endpoint returns a top-level array. `.loose()` on each row keeps unobserved
// fields so future additions don't break parsing.
// Observed at https://www2.sii.cl/app/cte-api-carpetatributaria/{rut}/recurso/v2/carpeta-tributaria/instituciones on 2026-09-02.
const InstitucionRow = z
  .object({
    enfinCodigo: z.string(),
    enfinDescripcion: z.string(),
    enfinAbreviacion: z.string().nullish(),
  })
  .loose();
const InstitucionesEnvelope = z.array(InstitucionRow);

function projectInstitucion(row: z.infer<typeof InstitucionRow>): Institucion {
  return {
    codigo: row.enfinCodigo,
    descripcion: row.enfinDescripcion,
    abreviacion: row.enfinAbreviacion ?? '',
  };
}

/** Fetch the raw instituciones list from SII and project to the curated shape. */
export async function fetchInstituciones(
  session: PortalSession,
  rut: Rut,
): Promise<readonly Institucion[]> {
  const res = await session.requestJson(institucionesUrl(rut), {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: GENERAR_PAGE,
    },
  });

  const parsed = InstitucionesEnvelope.safeParse(res);
  if (!parsed.success) {
    throw new CarpetaTributariaError(
      'SII devolvió un cuerpo inesperado para /instituciones (esperado un array de { enfinCodigo, enfinDescripcion, ... }).',
    );
  }
  if (parsed.data.length === 0) {
    throw new CarpetaTributariaError(
      'SII devolvió una lista vacía de instituciones para Carpeta Tributaria Regular.',
    );
  }
  return parsed.data.map(projectInstitucion);
}

function validateCodigo(codigo: string, instituciones: readonly Institucion[]): boolean {
  return instituciones.some((inst) => inst.codigo === codigo);
}

// Warm-up required by SII: without a `goto(GENERAR_PAGE)` + `/app/session/status`
// hit, every subsequent `/cte-api-carpetatributaria/*` call answers 401.
async function warmupCarpetaSession(session: PortalSession): Promise<void> {
  await session.goto(GENERAR_PAGE);
  await session.requestJson(sessionStatusUrl(GENERAR_PAGE), {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: GENERAR_PAGE,
    },
  });
}

/** Official instituciones list from SII, warm-up included. */
export async function fetchCarpetaTributariaInstitucionesList(
  session: PortalSession,
  rut: Rut,
): Promise<readonly Institucion[]> {
  await warmupCarpetaSession(session);
  return fetchInstituciones(session, rut);
}

/** Generate and download the Carpeta Tributaria Regular PDF from SII.
 *  Requires an already-authenticated session; www2.sii.cl shares SSO cookies
 *  with `.sii.cl`, so no extra login step is needed. */
export async function fetchCarpetaTributariaRegularPdf(
  session: PortalSession,
  params: { rut: Rut; formData: CarpetaTributariaRegularFormData },
): Promise<CarpetaTributariaRegularPdf> {
  // Phase 0: goto + warm-up. Then validate the requested código against the live list.
  await warmupCarpetaSession(session);

  const instituciones = await fetchInstituciones(session, params.rut);

  if (!validateCodigo(params.formData.institucionDestinataria, instituciones)) {
    const codigosValidos = instituciones.map((i) => i.codigo).join(', ');
    throw new CarpetaTributariaError(
      `Código de institución "${params.formData.institucionDestinataria}" no es válido. ` +
        `Códigos disponibles: ${codigosValidos}.`,
    );
  }

  // Phase 1: POST /generar with the receptor's data.
  const receptor = parseRutReceptor(params.formData.rutDestinatario);
  const generarPayload = {
    carpRutReceptor: receptor.body,
    carpDvReceptor: receptor.dv,
    carpMailReceptor: params.formData.emailDestinatario,
    carpTipo: 1,
    enfinCodigo: params.formData.institucionDestinataria,
    carpNombreOtraInstitucion: params.formData.otraInstitucion ?? '',
  };

  const generarRes = await session.requestJson(generarUrl(params.rut), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Referer: GENERAR_PAGE,
    },
    body: generarPayload,
  });

  if (!hasValidGenerarResponse(generarRes)) {
    throw new CarpetaTributariaError(
      'SII no devolvió los datos de generación esperados (carpCodigoRepositorio / carpClaveCarpeta).',
    );
  }

  // Phase 2: GET /pdfInicial/{carpCodigoRepositorio}. `obtenerValorParametro` is
  // NOT the PDF endpoint (see file header): on a live session it returns the URL
  // of the "cambiar email" widget as text/plain.
  const url = pdfInicialUrl(params.rut, generarRes.carpCodigoRepositorio);

  const res = await session.requestJson(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: GENERAR_PAGE,
    },
  });

  if (!res || typeof res !== 'object') {
    throw new CarpetaTributariaError(
      'SII devolvió una respuesta inesperada al obtener la Carpeta Tributaria Regular.',
    );
  }

  const { base64 } = res as Record<string, unknown>;

  if (typeof base64 !== 'string') {
    throw new CarpetaTributariaError(
      'SII no devolvió el campo base64 para la Carpeta Tributaria Regular.',
    );
  }

  if (!isValidBase64Pdf(base64)) {
    throw new CarpetaTributariaError(
      'El campo base64 de la Carpeta Tributaria Regular no parece ser un PDF.',
    );
  }

  return {
    rut: params.rut.canonical,
    contentType: 'application/pdf',
    base64,
    codigo: generarRes.carpCodigoRepositorio,
    clave: generarRes.carpClaveCarpeta,
  };
}

function hasValidGenerarResponse(res: unknown): res is {
  carpCodigoRepositorio: number;
  carpClaveCarpeta: string;
} {
  if (!res || typeof res !== 'object') return false;
  const r = res as Record<string, unknown>;
  return (
    typeof r.carpCodigoRepositorio === 'number' &&
    typeof r.carpClaveCarpeta === 'string' &&
    r.carpClaveCarpeta.length > 0
  );
}
