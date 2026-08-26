# `@takazudo/zudo-history-stash-ui`

Embeddable React primitives and provider hooks for History Stash consumers.

This initial scaffold exports the provider, capability hooks, router-agnostic link bridge, and
base primitives. The complete integration guide and component catalogue are added with the
viewer-consumer integration work.

Import the component CSS separately:

```ts
import "@takazudo/zudo-history-stash-ui/styles.css";
```

Hosts define the design tokens consumed by that stylesheet. A starting contract is shipped at
`@takazudo/zudo-history-stash-ui/styles/tokens.example.css` in the package tarball.
