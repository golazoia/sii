import { describe, it, expect } from 'vitest';
import { FakePortalSession } from '../adapters/fake/index.js';
import { CarpetaTributariaError } from '../errors/index.js';
import { Rut } from '../rut/index.js';
import {
  fetchCarpetaTributariaInstitucionesList,
  fetchCarpetaTributariaRegularPdf,
} from './carpeta-tributaria-regular.js';

// Synthetic throughout (no real RUT / email / codes — CONVENTIONS PII hygiene).
const RUT = Rut.parse('11111111-1');
const RECEPTOR_RUT = '22222222-2';
const RECEPTOR_EMAIL = 'receptor@example.com';

// Two synthetic instituciones. `enfinAbreviacion` is only present on one row on
// purpose to prove the `.loose()` boundary + nullish projection.
const INSTITUCIONES_OK = [
  { enfinCodigo: '001', enfinDescripcion: 'Institución de Prueba Uno', enfinAbreviacion: 'IPU' },
  { enfinCodigo: '002', enfinDescripcion: 'Institución de Prueba Dos' },
];

const GENERAR_OK = { carpCodigoRepositorio: 999999, carpClaveCarpeta: 'XXXXXXXXXX' };
// "JVBERi" is the base64 magic for a PDF header (%PDF).
const PDF_BASE64_OK = 'JVBERi0xLjQKc3ludGhldGljCiUlRU9G';

const FORM_DATA = {
  rutDestinatario: RECEPTOR_RUT,
  nombreDestinatario: 'Receptor Sintético',
  emailDestinatario: RECEPTOR_EMAIL,
  confirmarEmailDestinatario: RECEPTOR_EMAIL,
  institucionDestinataria: '001',
  otraInstitucion: '',
  autorizaDestinatario: true,
};

function makeScript(overrides: Record<string, unknown> = {}): (url: string) => unknown {
  const map: Record<string, unknown> = {
    'session/status': {},
    '/instituciones': INSTITUCIONES_OK,
    '/generar': GENERAR_OK,
    '/pdfInicial/': { base64: PDF_BASE64_OK },
    ...overrides,
  };
  return (url: string) => {
    for (const key of Object.keys(map)) if (url.includes(key)) return map[key];
    return null;
  };
}

describe('fetchCarpetaTributariaInstitucionesList (fake session, no SII)', () => {
  it('projects the SII wire shape to the curated {codigo, descripcion, abreviacion}', async () => {
    const session = new FakePortalSession({ requestJson: makeScript() });
    const list = await fetchCarpetaTributariaInstitucionesList(session, RUT);

    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ codigo: '001', descripcion: 'Institución de Prueba Uno', abreviacion: 'IPU' });
    // Nullish `enfinAbreviacion` becomes an empty string in the curated shape.
    expect(list[1]).toEqual({ codigo: '002', descripcion: 'Institución de Prueba Dos', abreviacion: '' });
    // The generación page must have been visited (warm-up requirement).
    expect(session.gotos).toContain('https://www2.sii.cl/carpetatributaria/generarcteregular');
  });

  it('rejects with CarpetaTributariaError when SII returns an empty list', async () => {
    const session = new FakePortalSession({ requestJson: makeScript({ '/instituciones': [] }) });
    await expect(fetchCarpetaTributariaInstitucionesList(session, RUT)).rejects.toThrow(
      CarpetaTributariaError,
    );
  });

  it('rejects with CarpetaTributariaError when the wire shape is unexpected', async () => {
    const session = new FakePortalSession({
      requestJson: makeScript({ '/instituciones': { not: 'an array' } }),
    });
    await expect(fetchCarpetaTributariaInstitucionesList(session, RUT)).rejects.toThrow(
      CarpetaTributariaError,
    );
  });
});

describe('fetchCarpetaTributariaRegularPdf (fake session, no SII)', () => {
  it('runs warm-up → instituciones → /generar → /pdfInicial and returns the base64 PDF', async () => {
    const session = new FakePortalSession({ requestJson: makeScript() });
    const res = await fetchCarpetaTributariaRegularPdf(session, { rut: RUT, formData: FORM_DATA });

    expect(res.rut).toBe(RUT.canonical);
    expect(res.contentType).toBe('application/pdf');
    expect(res.base64).toBe(PDF_BASE64_OK);
    expect(res.codigo).toBe(GENERAR_OK.carpCodigoRepositorio);
    expect(res.clave).toBe(GENERAR_OK.carpClaveCarpeta);
    // Last requestJson is the /pdfInicial GET.
    expect(session.lastRequest?.url).toContain('/pdfInicial/');
    expect(session.lastRequest?.options?.method).toBe('GET');
  });

  it('rejects when the requested código is not in the SII live list', async () => {
    const session = new FakePortalSession({ requestJson: makeScript() });
    await expect(
      fetchCarpetaTributariaRegularPdf(session, {
        rut: RUT,
        formData: { ...FORM_DATA, institucionDestinataria: '999' },
      }),
    ).rejects.toThrow(/Códigos disponibles: 001, 002/);
  });

  it('rejects when /pdfInicial returns a base64 that lacks the PDF magic', async () => {
    const session = new FakePortalSession({
      requestJson: makeScript({ '/pdfInicial/': { base64: 'bm90LWEtcGRm' } }),
    });
    await expect(
      fetchCarpetaTributariaRegularPdf(session, { rut: RUT, formData: FORM_DATA }),
    ).rejects.toThrow(/no parece ser un PDF/);
  });
});
