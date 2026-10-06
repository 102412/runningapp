import { z } from 'zod';
import { DataExportStatus } from './enums';
import { IdSchema, IsoDateTimeSchema } from './common';

export const CreateExportRequestSchema = z
  .object({
    password: z.string().min(1).max(200).describe('Your current password (re-authentication).'),
  })
  .strict();

export const DataExportSchema = z
  .object({
    id: IdSchema,
    status: DataExportStatus.schema,
    requestedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
    expiresAt: IsoDateTimeSchema.nullable().describe('When the file is deleted.'),
    sizeBytes: z.number().int().nullable(),
    downloadUrl: z
      .string()
      .nullable()
      .describe(
        'Short-lived signed URL; present only while READY. Fetch the export again for a fresh one.',
      ),
  })
  .meta({ id: 'DataExport' });
export type DataExport = z.infer<typeof DataExportSchema>;

export const DataExportListSchema = z
  .object({ items: z.array(DataExportSchema) })
  .meta({ id: 'DataExportList' });

export const ExportIdParamSchema = z.object({ id: IdSchema });
