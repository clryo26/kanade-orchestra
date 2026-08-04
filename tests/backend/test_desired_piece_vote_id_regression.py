from __future__ import annotations


def test_desired_piece_vote_rows_discard_existing_ids_on_replace(backend_env):
    children = backend_env.db_child_rows_for_collection(
        "desired_pieces",
        [
            {
                "id": 10,
                "votes": [
                    {
                        "id": 101,
                        "member_id": 1,
                        "name": "Existing Member",
                    },
                    {
                        "member_id": 2,
                        "name": "New Member",
                    },
                ],
            }
        ],
    )

    votes = children["desired_piece_votes"]

    assert [vote["id"] for vote in votes] == [None, None]
    assert [vote["desired_piece_id"] for vote in votes] == [10, 10]
    assert [vote["member_id"] for vote in votes] == [1, 2]
