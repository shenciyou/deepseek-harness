import { describe, expect, it } from 'vitest'
import { generateFunctionTypeSchema, generateRequestSchema } from '../src/contracts.ts'

describe('silipower generate contract', () => {
  it('rejects unknown function type and blank input', () => {
    expect(generateRequestSchema.safeParse({ functionType: 'unknown', inputContent: ' ' }).success).toBe(false)
  })

  it('preserves additional requirements', () => {
    expect(
      generateRequestSchema.parse({
        functionType: 'copywriting_generate',
        inputContent: 'AI 自媒体',
        additionalRequirements: '口播，500字',
      }).additionalRequirements,
    ).toBe('口播，500字')
  })
})

describe('generateFunctionTypeSchema', () => {
  it('accepts exactly the seven business function types', () => {
    expect(generateFunctionTypeSchema.options).toEqual([
      'account_planning',
      'copywriting_analysis',
      'copywriting_generate',
      'content_check',
      'data_diagnosis',
      'geo_outreach',
      'digital_human_script',
    ])
  })
})
