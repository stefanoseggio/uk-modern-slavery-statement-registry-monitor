import { describe, expect, it } from 'vitest';

import { isFullyCompliant, missingDisclosures, normalizeStatement } from '../src/deltaEngine.js';
import type { RawStatementRow } from '../src/types.js';

/** A minimal, realistic base row - every field a real StatementSummaries CSV row has, matching the live schema confirmed during this actor's build. */
function baseRow(overrides: Partial<RawStatementRow> = {}): RawStatementRow {
    return {
        StatementYear: '2026',
        OrganisationName: 'Acme Logistics Ltd',
        Address: '1 High Street\r\nLondon\r\nUnited Kingdom\r\nSW1A 1AA',
        SectorType: 'Private',
        CompanyNumber: '01234567',
        LastUpdated: '01/06/2026',
        GroupSubmission: '',
        ParentName: '',
        StatementURL: 'https://acme-logistics.example/modern-slavery-statement',
        StatementSummaryURL: 'https://modern-slavery-statement-registry.service.gov.uk/statement-summary/ABC12345/2026',
        StatementStartDate: '01/01/2025',
        StatementEndDate: '31/12/2025',
        DateApproved: '15/05/2026',
        StatementIncludesOrgStructure: 'Yes',
        StatementIncludesPolicies: 'Yes',
        StatementIncludesRisksAssessment: 'Yes',
        StatementIncludesDueDiligence: 'Yes',
        StatementIncludesTraining: 'Yes',
        StatementIncludesGoals: 'Yes',
        OrganisationSectors: 'Transportation and storage',
        Turnover: '£36 million to £60 million',
        ILOIndicatorsInStatement: '',
        PDFDate: '2026-05-15T10:00:00',
        PDFURL: 'https://downloads.modern-slavery-statement-registry.service.gov.uk/pdf-published/ABC12345/2026/statement.pdf',
        ...overrides,
    };
}

describe('normalizeStatement', () => {
    it('maps a standard real-shaped row to a fully populated NormalizedStatement', () => {
        const result = normalizeStatement(baseRow());
        expect(result.organisationName).toBe('Acme Logistics Ltd');
        expect(result.companyNumber).toBe('01234567');
        expect(result.sectorType).toBe('Private');
        expect(result.turnover).toBe('£36 million to £60 million');
        expect(result.groupSubmission).toBe(false);
        expect(result.includesOrgStructure).toBe(true);
        expect(result.includesGoals).toBe(true);
        expect(result.iloIndicatorsInStatement).toBe(false);
        expect(result.statementYear).toBe('2026');
    });

    it('joins a real CRLF-multi-line Address into a single readable string', () => {
        const result = normalizeStatement(baseRow());
        expect(result.address).toBe('1 High Street, London, United Kingdom, SW1A 1AA');
    });

    it('splits a real CRLF-multi-line OrganisationSectors field into a clean array', () => {
        const result = normalizeStatement(
            baseRow({ OrganisationSectors: 'Transportation and storage\r\nWholesale and retail trade' }),
        );
        expect(result.organisationSectors).toEqual(['Transportation and storage', 'Wholesale and retail trade']);
    });

    it('treats a blank CompanyNumber as null, not an empty string (confirmed live: frequently blank)', () => {
        const result = normalizeStatement(baseRow({ CompanyNumber: '' }));
        expect(result.companyNumber).toBeNull();
    });

    it('treats GroupSubmission="Yes" as true and anything else as false', () => {
        expect(normalizeStatement(baseRow({ GroupSubmission: 'Yes' })).groupSubmission).toBe(true);
        expect(normalizeStatement(baseRow({ GroupSubmission: '' })).groupSubmission).toBe(false);
    });

    it('falls back to ParentName for DISPLAY when OrganisationName is a bare numeric reference (real, confirmed edge case: ~0.1% of live 2026 rows), but keeps the raw numeric value in recordId', () => {
        const result = normalizeStatement(baseRow({ OrganisationName: '10246724', ParentName: 'ODEON CINEMAS GROUP LIMITED' }));
        expect(result.organisationName).toBe('ODEON CINEMAS GROUP LIMITED');
        // recordId intentionally does NOT apply the same numeric-placeholder fallback as display -
        // it uses the raw per-row value so two different bare-numeric-ID rows sharing a
        // StatementSummaryURL still get distinct keys instead of colliding on a shared ParentName.
        expect(result.recordId).toBe(`${result.statementSummaryUrl}::10246724`);
    });

    it('does NOT fall back to ParentName for a normal alphanumeric OrganisationName even when GroupSubmission=Yes', () => {
        const result = normalizeStatement(baseRow({ OrganisationName: 'Bandvulc Tyres Ltd', ParentName: 'CONTINENTAL TYRE GROUP LTD.', GroupSubmission: 'Yes' }));
        expect(result.organisationName).toBe('Bandvulc Tyres Ltd');
    });

    it('strips stray literal quote characters some real rows carry as data (confirmed live)', () => {
        const result = normalizeStatement(baseRow({ OrganisationName: '"Edelweiss Air Ltd."' }));
        expect(result.organisationName).toBe('Edelweiss Air Ltd.');
    });

    it('throws when StatementSummaryURL is missing - there is no stable identifier to track this record by', () => {
        expect(() => normalizeStatement(baseRow({ StatementSummaryURL: '' }))).toThrow(/StatementSummaryURL/);
    });

    it('builds a compound recordId (URL + organisation), not just the bare StatementSummaryURL', () => {
        const result = normalizeStatement(baseRow());
        expect(result.recordId).toBe(`${result.statementSummaryUrl}::Acme Logistics Ltd`);
    });

    it('gives two different organisations sharing the same StatementSummaryURL two different recordIds (the real group-statement finding from the live 2027 file)', () => {
        const sharedUrl = 'https://modern-slavery-statement-registry.service.gov.uk/statement-summary/M4EPd37H/2027';
        const orgA = normalizeStatement(baseRow({ StatementSummaryURL: sharedUrl, OrganisationName: 'CONCERT LIVING LIMITED' }));
        const orgB = normalizeStatement(baseRow({ StatementSummaryURL: sharedUrl, OrganisationName: 'KEY UNLOCKING FUTURES LIMITED' }));
        expect(orgA.recordId).not.toBe(orgB.recordId);
        expect(orgA.statementSummaryUrl).toBe(orgB.statementSummaryUrl);
    });

    it('falls back to ParentName, then CompanyNumber, for recordId when OrganisationName is blank', () => {
        const byParent = normalizeStatement(baseRow({ OrganisationName: '', ParentName: 'Some Group Ltd' }));
        expect(byParent.recordId).toBe(`${byParent.statementSummaryUrl}::Some Group Ltd`);

        const byCompanyNumber = normalizeStatement(baseRow({ OrganisationName: '', ParentName: '', CompanyNumber: '09876543' }));
        expect(byCompanyNumber.recordId).toBe(`${byCompanyNumber.statementSummaryUrl}::09876543`);
    });

    it('does not collide two different organisations sharing a URL when OrganisationName, ParentName, and CompanyNumber are ALL blank for both (regression test found by adversarial review: a prior version used a single static fallback literal here)', () => {
        const sharedUrl = 'https://modern-slavery-statement-registry.service.gov.uk/statement-summary/BLANKID01/2026';
        const rowA = baseRow({
            StatementSummaryURL: sharedUrl,
            OrganisationName: '',
            ParentName: '',
            CompanyNumber: '',
            DateApproved: '01/01/2026',
            StatementStartDate: '01/01/2025',
        });
        const rowB = baseRow({
            StatementSummaryURL: sharedUrl,
            OrganisationName: '',
            ParentName: '',
            CompanyNumber: '',
            DateApproved: '02/02/2026', // a different real field distinguishes the two rows
            StatementStartDate: '01/01/2025',
        });
        const a = normalizeStatement(rowA);
        const b = normalizeStatement(rowB);
        expect(a.recordId).not.toBe(b.recordId);
    });
});

describe('missingDisclosures / isFullyCompliant', () => {
    it('reports no missing disclosures when all six recommended topics are covered', () => {
        const statement = normalizeStatement(baseRow());
        expect(missingDisclosures(statement)).toEqual([]);
        expect(isFullyCompliant(statement)).toBe(true);
    });

    it('reports exactly the uncovered topics, in the real government-defined order', () => {
        const statement = normalizeStatement(
            baseRow({ StatementIncludesPolicies: '', StatementIncludesGoals: '' }),
        );
        expect(missingDisclosures(statement)).toEqual(['Policies', 'Goals']);
        expect(isFullyCompliant(statement)).toBe(false);
    });

    it('reports all six topics missing when none are covered', () => {
        const statement = normalizeStatement(
            baseRow({
                StatementIncludesOrgStructure: '',
                StatementIncludesPolicies: '',
                StatementIncludesRisksAssessment: '',
                StatementIncludesDueDiligence: '',
                StatementIncludesTraining: '',
                StatementIncludesGoals: '',
            }),
        );
        expect(missingDisclosures(statement)).toHaveLength(6);
        expect(isFullyCompliant(statement)).toBe(false);
    });
});
