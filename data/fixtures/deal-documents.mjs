export function createDealDocumentsFixture() {
  const documents = ['Demo Lease.pdf', 'Demo Counteroffer.pdf', 'Demo Amendment.pdf'].map((filename, i) => ({
    id: `00000000-0000-4000-8000-00000000003${i}`, subject_type: 'deal', subject_id: 'd14', filename,
  }));
  return {
    attachments: entity => structuredClone(documents.filter(doc => doc.subject_id === entity)),
    async listDealDocuments({ deal_id }) { return { ok: true, schema_version: 'deal-documents.v1', documents: documents.filter(doc => doc.subject_id === deal_id).map(doc => ({ id: doc.id, display_name: doc.filename, stored_at: '2026-01-01T00:00:00Z', document_type: 'application/pdf', page_count: null, content_hash: 'a'.repeat(64) })), has_more: false, next_cursor: null }; },
  };
}
