"""The extensible-design pieces: the instrument registry, the In Situ TAC reader, and the
machine-learning product in the catalogue. Real files only (`fetch_fixtures` pulls them);
the reader test skips rather than fetches when they are absent."""

import pytest

from server.ocean import catalog, config, insitu, instruments


def test_registry_asks_each_instrument_only_for_what_it_measures():
    instruments.demo()


def test_catalogue_labels_every_ml_product():
    catalog.demo()


def test_insitu_reader_on_real_mooring_adcp_and_hf_radar_files():
    files = [*config.INSITU_PLATFORMS["mooring"][:1], *config.INSITU_SAMPLES.values()]
    if not all((insitu.CACHE / f.split("/")[-1]).exists() for f in files):
        pytest.skip("run `python -m server.tools.fetch_fixtures` first")
    insitu.demo()
