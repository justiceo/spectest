// Config for payloads.arazzo.yaml. Its `$self` is a (fake) https URL, so per Arazzo 1.1
// the relative source description resolves against it; arazzoSources points it back at
// the local file. The hook is the one referenced by x-spectest.beforeSend.
import { fileURLToPath } from 'node:url';

export default {
  arazzoSources: {
    shop: fileURLToPath(new URL('./shop.openapi.yaml', import.meta.url)),
  },
  openapiHooks: {
    addTrace: {
      beforeSend: (req) => ({ ...req, headers: { ...req.headers, 'X-Trace': 'from-hook' } }),
    },
  },
};
