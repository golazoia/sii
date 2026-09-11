// `sii carpeta …` — Carpeta Tributaria del SII. Thin calls into @albertomarturelo/sii-core tasks (ADR-003).
// SESSION-KEYED (ADR-005): always reads the session principal — NO `--rut`; a represented
// empresa's Carpeta Tributaria needs the empresa's own session (logout→login).
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  carpetaTributariaInstituciones,
  carpetaTributariaRegularGenerar,
  formatRut as fmtRut,
  type Runtime,
} from '@albertomarturelo/sii-core';
import { DOCUMENTOS_DIR } from '@albertomarturelo/sii-core/node';
import { emit, out } from '../io.js';

export function registerCarpeta(program: Command, runtime: Runtime): void {
  const carpeta = program.command('carpeta').description('Carpeta Tributaria del SII.');

  carpeta
    .command('regular')
    .description(
      'Genera y descarga la Carpeta Tributaria Regular oficial del SII (PDF) ' +
        'desde www2.sii.cl. Requiere datos del destinatario.',
    )
    .option('--out <dir>', 'Carpeta destino.', join(DOCUMENTOS_DIR, 'carpeta-tributaria'))
    .requiredOption('--rut-destinatario <rut>', 'RUT del destinatario.')
    .requiredOption('--nombre-destinatario <nombre>', 'Nombre del destinatario.')
    .requiredOption('--email-destinatario <email>', 'Correo del destinatario.')
    .requiredOption('--confirmar-email-destinatario <email>', 'Confirmación del correo.')
    .requiredOption('--institucion-destinataria <institucion>', 'Institución destinataria.')
    .option('--otra-institucion <otra>', 'Otra institución (si aplica).')
    .requiredOption('--autorizo', 'Confirma autorización al destinatario.', true)
    .action(
      async (
        opts: {
          out: string;
          rutDestinatario: string;
          nombreDestinatario: string;
          emailDestinatario: string;
          confirmarEmailDestinatario: string;
          institucionDestinataria: string;
          otraInstitucion?: string;
          autorizo: boolean;
        },
      ) => {
        const res = await carpetaTributariaRegularGenerar(runtime, {
          directorio: opts.out,
          formData: {
            rutDestinatario: opts.rutDestinatario,
            nombreDestinatario: opts.nombreDestinatario,
            emailDestinatario: opts.emailDestinatario,
            confirmarEmailDestinatario: opts.confirmarEmailDestinatario,
            institucionDestinataria: opts.institucionDestinataria,
            otraInstitucion: opts.otraInstitucion ?? '',
            autorizaDestinatario: opts.autorizo,
          },
        });
        emit(res, () => {
          out(`Carpeta Tributaria Regular — ${fmtRut(res.rut)}`);
          out(`  ${(res.bytes / 1024).toFixed(1)} KB  ${res.path}`);
        });
      },
    );

  carpeta
    .command('instituciones')
    .description('Lista las instituciones destinatarias válidas para Carpeta Tributaria Regular (fuente: SII).')
    .action(async () => {
      const res = await carpetaTributariaInstituciones(runtime);
      emit(res, () => {
        out(`Instituciones válidas — ${fmtRut(res.rut)} (${res.instituciones.length})`);
        for (const inst of res.instituciones) {
          out(`  ${inst.codigo.padStart(4)}  ${inst.descripcion}`);
        }
      });
    });
}
