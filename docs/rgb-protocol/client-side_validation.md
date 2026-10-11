# Client-side Validation

In a distributed system, every validation process aims to **assess the validity and the chronological ordering of states**, hence to verify that state transitions correctly follow the protocol rules.

![](https://160813645-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FaUAGORrT1fl6qzaZSTKt%2Fuploads%2Fgit-blob-ca52eafb071654a987807ad2becc31cefcb6d9d6%2Fstate-passages.webp?alt=media)

**A consensus-based system allows the operator to track the changes of certain properties over time.**

Taking the Bitcoin blockchain as an example, this tracking process is meant to verify that the changes to the [UTXO set](https://en.wikipedia.org/wiki/Unspent_transaction_output) are valid. In fact, with every new block added to the chain (i.e. the ordered sequence), the UTXO set gets modified. Thus, every block represents a **state update**.

![](https://160813645-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FaUAGORrT1fl6qzaZSTKt%2Fuploads%2Fgit-blob-f980a9bf3c7d3916598d8188d78144a6e93d4569%2Futxo-set-1.webp?alt=media)

**In Bitcoin, the system state is represented by the UTXO Set, which represents the ownership of bitcoins.**

The main drawback of Layer 1's validation process is that **each node must validate all transactions (even those coming from other nodes) and store the related data** long after the block is added on top of the chain. This architecture leads to two main issues:

- **Scalability**: the size limit of the blocks, versus the demand for blockspace per unit of time among participants, limits the transaction throughput (i.e. a maximum of 1 MB on 10 minutes on average on bitcoin, taking into account [witness discount](https://en.bitcoin.it/wiki/Segregated_Witness)).
- **Privacy**: the details of each transaction are broadcast and stored publicly (in particular, the amounts transacted and the receiving addresses are visible to everyone, albeit pseudonymous).

![](https://160813645-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FaUAGORrT1fl6qzaZSTKt%2Fuploads%2Fgit-blob-2866d672dfaffb60814f67659b5fa479fc4540a8%2Fblockchain-1.webp?alt=media)

**In public blockchains, every node must validate and store every transaction, which generates scalability and privacy issues.**

However, from the recipient's perspective, only two aspects matter:

- The most recent state transition, represented by a transaction addressed to the recipient themselves.
- The chronological sequence of transactions (and thus state transitions) leading up to the last one.

What is relevant to the recipient is the chain of ownership transfers from a set of coinbase transactions to the last transaction addressed to them, i.e. their Directed Acyclic Graph, which is only a subset of the complete dataset.

![](https://160813645-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FaUAGORrT1fl6qzaZSTKt%2Fuploads%2Fgit-blob-717c69596315918bffd721614f579654e747d532%2Ftransaction-graph-1.webp?alt=media)

**The transaction graph of public blockchains cannot be sharded: since any transaction may reference an output created anywhere in prior history, all nodes must maintain a consistent view of the entire history, in order to validate new blocks.**

For this reason, the **conventional validation logic can be reversed** as follows:

- Each party validates its **own portion of the history**, and thus the digital properties that matter to them.
- A compact reference to the **validated state transition is committed in Layer 1** to be timestamped. This construction constitutes a [Proof-of-Publication](https://petertodd.org/2017/scalable-single-use-seal-asset-transfer) and acts as an **anti-double-spending measure**.

![](https://160813645-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FaUAGORrT1fl6qzaZSTKt%2Fuploads%2Fgit-blob-2fd2b98e9741566adcaf27dbcf3202436a9270c2%2Fcsv-blocks-1.webp?alt=media)

  
**Layer 1 blocks remain public, while client-side validated state transitions are aggregated and committed through suitable Merkelization within Layer 1 transactions.**

**Client-side Validation** ensures that the following properties are met:

- **Scalability**: since the commitment of the verified state, which must be stored by all, has, at least, a small footprint (order of tens of bytes), or, in [some commitment scheme](/commitment-layer/deterministic-bitcoin-commitments-dbc/tapret.md), no additional footprint in respect to an ordinary transaction.
- **Privacy**: using a [one-way cryptographic hash function](https://en.wikipedia.org/wiki/Cryptographic_hash_function) (such as [SHA-256](https://en.wikipedia.org/wiki/SHA-2)), the original data (the pre-image) that generated the commitment cannot be reconstructed, thus keeping it private to the parties involved.

![](https://160813645-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FaUAGORrT1fl6qzaZSTKt%2Fuploads%2Fgit-blob-d6d8a71553abe568392fc4cb4263f9eaa8a6a0c0%2Fcsv-shard-1.webp?alt=media)

**Multiple data packages can be aggregated in a single Layer 1 transaction. The Anchor structure establishes a deterministic link between the client-side data of the contract and the single-use seal.**

The commitment structure used in client-side validation (as implemented in the RGB protocol, which we will cover in detail [later](/commitment-layer/commitment-schemes.md)) allows for important additional scalability features:

- The aggregation of state transitions from different contracts (e.g., two different contracts related to 2 different digital assets committed in a single Bitcoin transaction).
- The bundling of multiple state transitions of the same asset in a single client-side operation.

[Anchor](/commitment-layer/anchors.md) structures provide the deterministic link between the [single-use seal](/distributed-computing-concepts/single-use-seals.md) and the client-side data representing the message over which the [single-use seal is closed](/distributed-computing-concepts/single-use-seals.md#seal-closing).

To guarantee the efficacy of the commitment scheme and the precise chronological ordering derived from Layer 1, a new cryptographic primitive needs to be introduced: the **Single-use Seal**.

---

