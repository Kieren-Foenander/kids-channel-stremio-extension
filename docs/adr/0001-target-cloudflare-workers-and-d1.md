# Target Cloudflare Workers and D1

The addon will target Cloudflare Workers with D1 from the outset rather than retaining the Node server or relying on a household machine. Fire TV needs an always-available HTTPS endpoint, the Parent should not need to operate a home server, and the same deployment model should support eventual use by other households; accepting the Worker runtime and D1 data model now avoids building and later porting a stateful Node service.
