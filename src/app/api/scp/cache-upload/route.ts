import { NextResponse } from 'next/server';
import { parseScpCsv } from '@/lib/scp';
import { runScpCacheFreshnessCheck, upsertScpCacheCsv } from '@/lib/db';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const consoleName = String(formData.get('consoleName') ?? '').trim();
    const sourceConsoleUrlRaw = String(formData.get('sourceConsoleUrl') ?? '').trim();
    const sourceConsoleUrl = sourceConsoleUrlRaw || null;
    const file = formData.get('file');

    if (!consoleName) {
      return NextResponse.json({ error: 'Console name is required.' }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'CSV file is required.' }, { status: 400 });
    }

    const csvText = await file.text();
    const parsed = parseScpCsv(csvText);
    if (parsed.length === 0) {
      return NextResponse.json({ error: 'CSV did not contain any readable SCP product rows.' }, { status: 400 });
    }

    const storagePath = await upsertScpCacheCsv(consoleName, csvText, sourceConsoleUrl);
    const summary = await runScpCacheFreshnessCheck('upload', {
      force: true,
      message: `Uploaded ${parsed.length} cached SCP rows for ${consoleName}.`,
    });
    return NextResponse.json({
      ok: true,
      storagePath,
      summary,
      message: `Uploaded ${parsed.length} cached SCP rows for ${consoleName}.`,
    });
  } catch (error) {
    try {
      await runScpCacheFreshnessCheck('upload', {
        force: true,
        message: error instanceof Error ? error.message : 'Unable to upload SCP CSV cache',
        errorCount: 1,
      });
    } catch {
      // ignore secondary logging failures
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to upload SCP CSV cache' },
      { status: 500 },
    );
  }
}
