## Terminology

This library can be used to bridge with many different networks. This makes it
hard to identify the "outside network" via a single consistent name for types
and function names. This library refers to the "outside network" as the
`Jungle`: after all, it *is* a jungle out there. This name makes it easier to
intuit what `getJungleId` means, versus the alternative `getBridgedUserId` which
could be confused with Matrix's `user_id`. This also makes it a lot easier to
`grep`!