/**
 * Scenario Extractor Dispatcher - routes a detected scenario to its
 * structured extractor and returns a normalized extraction result.
 *
 * Each scenario uses a robust OCR/algorithm-driven extractor (NOT VLM-trusted)
 * following the "requirement analysis strategy" pattern established in
 * key-content-extractor.  The dispatcher keeps the call site (vision-analyze)
 * free of per-scenario branching.
 */
import type { ImageInput } from '../../types/domain.js';
import type { OcrItem } from '../key-content-extractor.js';
import { extractOcrItems } from '../key-content-extractor.js';
import { detectScenario, type ScenarioType, type ScenarioDetection } from '../scenario-resolver.js';
import { extractChart, type ChartExtraction } from './chart-extractor.js';
import { extractDiagram, type DiagramExtraction } from './diagram-extractor.js';
import { extractDocument, type DocumentExtraction } from './document-extractor.js';
import { extractCode, type CodeExtraction } from './code-extractor.js';
import { extractForm, type FormExtraction } from './form-extractor.js';
import { logger } from '../../utils/logger.js';

export type ScenarioExtraction =
  | { scenario: 'chart'; data: ChartExtraction }
  | { scenario: 'diagram'; data: DiagramExtraction }
  | { scenario: 'invoice'; data: DocumentExtraction }
  | { scenario: 'code'; data: CodeExtraction }
  | { scenario: 'form'; data: FormExtraction }
  | { scenario: 'requirement' | 'general'; data: undefined };

export interface ScenarioExtractionInput {
  image: ImageInput;
  intent: string;
  category?: string | undefined;
  hasAnnotations?: boolean | undefined;
  hasTarget?: boolean | undefined;
  ocrData?: unknown;
  ocrItems?: OcrItem[] | undefined;
}

/**
 * Detect the scenario and, if it has a dedicated extractor, run it.
 * Returns `undefined` for `requirement`/`general` scenarios (handled by
 * key-content-extractor / composeResult respectively).
 */
export async function extractForScenario(input: ScenarioExtractionInput): Promise<{
  detection: ScenarioDetection;
  extraction: ScenarioExtraction['data'];
}> {
  const detection = detectScenario({
    intent: input.intent,
    category: input.category,
    hasAnnotations: input.hasAnnotations,
    hasTarget: input.hasTarget,
  });

  const items = input.ocrItems ?? extractOcrItems(input.ocrData, 'full');

  let data: ScenarioExtraction['data'];
  try {
    switch (detection.scenario) {
      case 'chart': {
        const chartInput: Parameters<typeof extractChart>[0] = { image: input.image, ocrItems: items };
        if (input.category !== undefined) chartInput.category = input.category;
        data = await extractChart(chartInput);
        break;
      }
      case 'diagram':
        data = await extractDiagram({ image: input.image, ocrItems: items });
        break;
      case 'invoice': {
        const docInput: Parameters<typeof extractDocument>[0] = { intent: input.intent, ocrItems: items };
        if (input.category !== undefined) docInput.category = input.category;
        data = extractDocument(docInput);
        break;
      }
      case 'code':
        data = extractCode({ ocrItems: items, intent: input.intent });
        break;
      case 'form':
        data = extractForm({ ocrItems: items });
        break;
      default:
        data = undefined;
    }
  } catch (err) {
    logger.warn('scenario extraction failed; falling back to OCR-driven summary', {
      scenario: detection.scenario,
      error: String(err),
    });
    data = undefined;
  }

  return { detection, extraction: data };
}

/**
 * Append a scenario extraction's summary to the result summary, mirroring
 * appendKeyContentSummary / appendAnnotationSummary.
 */
export function appendScenarioSummary(
  summary: string,
  extraction: ScenarioExtraction['data'],
): string {
  if (!extraction) return summary;
  const scenarioSummary = extraction.summary;
  if (!scenarioSummary) return summary;
  return summary ? `${summary}${scenarioSummary}` : scenarioSummary;
}

/** Re-export for callers that need the raw scenario type. */
export type { ScenarioType };
