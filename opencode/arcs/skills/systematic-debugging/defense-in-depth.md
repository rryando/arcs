# Defense in Depth

After fixing the root cause, add another guard only when it prevents a distinct realistic failure:

- validate at an input boundary;
- preserve an invariant in the domain layer;
- make an unsafe state unrepresentable;
- monitor a failure that cannot be prevented.

Do not duplicate the same check across layers without a concrete failure mode.
