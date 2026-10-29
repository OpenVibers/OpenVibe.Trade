'use strict';
// What openvibe.trade tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the bearer-token API, the pages that list what is
// known, llms.txt and the sitemap.
module.exports = {
    id: 'trade',
    name: 'OpenVibe.Trade',
    purpose: 'Company figures and filings gathered from public sources: every number keeps the date it was observed and the source it came from, and a stale figure says so.',
    home: 'https://openvibe.trade',
    site: 'openvibe.trade',
    api: '/api/v1',
    policy: {
        auth: ['none', 'Network OIDC'],
    },
};
